import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type UIEvent,
} from "react";
import * as Y from "yjs";
import type {
  AppSettingsInfo,
  AudioTranscriptionInfo,
  HostInfo,
  ImportedAudioInfo,
  SessionEvent,
  SessionInfo,
} from "../../packages/shared/types";
import {
  clearBrowserCaches,
  cacheSessionPayload,
  cacheShell,
  getMeta,
  loadCacheStats,
  loadHosts,
  loadSessionEvents,
  loadSessions,
  resetIndexedDbCache,
  setMeta,
  unregisterServiceWorkers,
  type CacheStats,
} from "./db";
import {
  appendCachedAudioChunk,
  createCachedAudioRecording,
  deleteCachedAudioRecording,
  finalizeCachedAudioRecording,
  loadCachedAudioBlob,
  loadCachedAudioRecordings,
  markCachedAudioRecordingStatus,
  type CachedAudioRecording,
} from "./audio-cache";
import {
  AudioModal,
  FALLBACK_REASONING_EFFORTS,
  FALLBACK_TRANSCRIPTION_MODELS,
  chooseRecorderMimeType,
  extensionForMime,
  isAudioLikeFile,
  type AudioRetryOptions,
  type RecordingUiState,
  type TranscriptLanguage,
} from "./audio-panel";
import { flatten, groupItems, VirtualChat } from "./chat-transcript";
import { flushClientLogs, installClientLogHandlers, logClientEvent } from "./client-logs";
import { parseRoute, useRoute, type RoutePanel } from "./router";
import { fetchSessionEvents, fetchSessionMetadata, pullUpdates, SyncAuthError } from "./sync";
import {
  docIdForSession,
  getDraft,
  loadDraftDoc,
  mergeCachedDraftUpdate,
  openYjsSocket,
  persistDraftDoc,
  sendYjsSocketUpdate,
  setDraft as setYDraft,
  subscribeYjsSocket,
  syncCachedDraftDocs,
  syncDraftDoc,
} from "./yjs";

type SyncState = "loading" | "syncing" | "idle" | "offline" | "error";
type AuthState = "checking" | "authenticated" | "anonymous";
type EventState = { sessionId: string | null; events: SessionEvent[] };
type SyncNowOptions = { silent?: boolean; metadataOnly?: boolean };

const SIDEBAR_SESSION_PAGE_SIZE = 80;
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 680;
const SIDEBAR_WIDTH_STORAGE_KEY = "chatview:sidebar-width";
const GROUP_BY_PROJECT_STORAGE_KEY = "chatview:group-by-project";
const PROVIDER_FILTER_STORAGE_KEY = "chatview:provider-filter";
const DEVICE_FILTER_STORAGE_KEY = "chatview:device-filter";

function formatBytes(value?: number | null) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value?: string | null) {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function formatNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unknown";
}

function formatLimit(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unlimited";
}

function readLocalStorageString(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocalStorageValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function readLocalStorageBoolean(key: string, fallback: boolean) {
  const value = readLocalStorageString(key, fallback ? "true" : "false");
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function sidebarWidthLimit() {
  const viewportLimit = typeof window === "undefined" ? MAX_SIDEBAR_WIDTH : Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 28);
  return Math.min(MAX_SIDEBAR_WIDTH, viewportLimit);
}

function clampSidebarWidth(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.round(Math.min(sidebarWidthLimit(), Math.max(MIN_SIDEBAR_WIDTH, value)));
}

function readSidebarWidth() {
  const value = Number(readLocalStorageString(SIDEBAR_WIDTH_STORAGE_KEY, String(DEFAULT_SIDEBAR_WIDTH)));
  return clampSidebarWidth(value);
}

function shallowEqualObject(a: object, b: object) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}

function sameEntityList<T extends object>(current: T[], next: T[], keyOf: (item: T) => string) {
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (keyOf(current[index]) !== keyOf(next[index])) return false;
    if (!shallowEqualObject(current[index], next[index])) return false;
  }
  return true;
}

function shortId(value: string, size = 8) {
  return value.length <= size ? value : value.slice(0, size);
}

function sourceProviderLabel(session: SessionInfo) {
  const provider = providerFilterValue(session);
  return providerLabel(provider);
}

function providerFilterValue(session: SessionInfo) {
  return session.sourceProvider || (session.id.startsWith("v2:") ? "v2" : "legacy");
}

function providerLabel(provider: string) {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "gemini") return "Gemini";
  if (provider === "legacy") return "Legacy";
  if (provider === "v2") return "V2";
  if (provider === "unknown") return "Unknown";
  return provider.slice(0, 1).toUpperCase() + provider.slice(1);
}

function sourceGenerationLabel(session: SessionInfo) {
  return session.sourceGeneration ? `g${session.sourceGeneration}` : null;
}

function hostLabel(hostname: string, agentId: string, duplicateHostnames: Set<string>) {
  return duplicateHostnames.has(hostname) ? `${hostname} · ${shortId(agentId)}` : hostname;
}

function sessionSourceTitle(session: SessionInfo) {
  return [
    `Provider: ${sourceProviderLabel(session)}`,
    `Host: ${session.hostname}`,
    `Agent: ${session.agentId}`,
    session.sourceGeneration ? `Generation: ${session.sourceGeneration}` : null,
    `Source: ${session.sourcePath}`,
    session.gitBranch ? `Git: ${session.gitBranch}${session.gitCommit ? ` @ ${shortId(session.gitCommit, 10)}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function openRouterStatusLabel(settings: AppSettingsInfo | null) {
  const status = settings?.openRouter.status;
  if (status === "ok") return "ready";
  if (status === "checking") return "checking";
  if (status === "error") return "error";
  return "missing";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function ModalFrame({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactElement | ReactElement[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button compact-button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function SettingsModal({
  settings,
  cacheStats,
  loading,
  message,
  onClose,
  onRefresh,
  onCopy,
  onCreateToken,
  onCheckOpenRouter,
  onResetIndexedDb,
  onClearCaches,
  onUnregisterServiceWorkers,
  groupByProject,
  sidebarWidth,
  onGroupByProjectChange,
  onResetSidebarWidth,
}: {
  settings: AppSettingsInfo | null;
  cacheStats: CacheStats | null;
  loading: boolean;
  message: string;
  onClose: () => void;
  onRefresh: () => void;
  onCopy: (value: string) => void;
  onCreateToken: () => void;
  onCheckOpenRouter: () => void;
  onResetIndexedDb: () => void;
  onClearCaches: () => void;
  onUnregisterServiceWorkers: () => void;
  groupByProject: boolean;
  sidebarWidth: number;
  onGroupByProjectChange: (value: boolean) => void;
  onResetSidebarWidth: () => void;
}) {
  const openRouter = settings?.openRouter;
  const openRouterReady = openRouter?.status === "ok";
  const openRouterKey = openRouter?.key;
  return (
    <ModalFrame title="Settings" onClose={onClose}>
      <div className="modal-body">
        <div className="settings-section">
          <div className="section-title">iPhone Upload</div>
          {settings?.importTokens.length ? (
            <div className="url-list">
              {settings.importTokens.map((token) => (
                <div className="url-row" key={token.id}>
                  <div className="url-meta">
                    <span>{token.label}</span>
                    <span>{token.tokenPreview} / last used {formatDate(token.lastUsedAt)}</span>
                  </div>
                  <code>{token.uploadUrl}</code>
                  <button className="icon-button compact-button" onClick={() => onCopy(token.uploadUrl)}>
                    Copy
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-text">No import tokens yet.</div>
          )}
          <button className="icon-button" onClick={onCreateToken} disabled={loading}>
            New token
          </button>
        </div>

        <div className="settings-section">
          <div className="section-title">OpenRouter</div>
          <div className={`service-status ${openRouterStatusLabel(settings)}`}>
            <span>{openRouterStatusLabel(settings)}</span>
            <b>{openRouter?.message ?? "OPENROUTER_API_KEY is not configured"}</b>
          </div>
          <div className="kv-grid">
            <span>Configured</span>
            <b>{openRouter?.configured ? "yes" : "no"}</b>
            <span>Model</span>
            <b>{openRouter?.model ?? "unknown"}</b>
            <span>Reasoning</span>
            <b>{openRouter?.reasoningEffort ?? "medium"}</b>
            <span>Key label</span>
            <b>{openRouterKey?.label ?? (openRouter?.configured ? "unknown" : "missing")}</b>
            <span>Limit remaining</span>
            <b>{openRouterReady ? formatLimit(openRouterKey?.limitRemaining) : "not available"}</b>
            <span>Usage</span>
            <b>{openRouterReady ? formatNumber(openRouterKey?.usage) : "not available"}</b>
            <span>Rate limit</span>
            <b>
              {typeof openRouterKey?.rateLimit?.requests === "number" && openRouterKey.rateLimit.requests > 0
                ? `${openRouterKey.rateLimit.requests.toLocaleString()} / ${openRouterKey.rateLimit.interval ?? "window"}`
                : "not available"}
            </b>
            <span>Checked</span>
            <b>{formatDate(openRouter?.checkedAt)}</b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onCheckOpenRouter} disabled={loading}>
              Check OpenRouter
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="section-title">Interface</div>
          <label className="toggle-row">
            <input type="checkbox" checked={groupByProject} onChange={(event) => onGroupByProjectChange(event.target.checked)} />
            <span>
              <b>Group chats by project</b>
            </span>
          </label>
          <div className="kv-grid">
            <span>Sidebar width</span>
            <b>{sidebarWidth}px</b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onResetSidebarWidth}>
              Reset sidebar width
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="section-title">Cache</div>
          <div className="kv-grid">
            <span>Storage</span>
            <b>
              {formatBytes(cacheStats?.storageUsageBytes)} / {formatBytes(cacheStats?.storageQuotaBytes)}
            </b>
            <span>IndexedDB</span>
            <b>{cacheStats ? Object.entries(cacheStats.indexedDb).map(([k, v]) => `${k}:${v}`).join(" ") : "loading"}</b>
            <span>Cache API</span>
            <b>{cacheStats?.cacheNames.length ?? 0}</b>
            <span>Service workers</span>
            <b>{cacheStats?.serviceWorkers ?? 0}</b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onRefresh} disabled={loading}>
              Refresh
            </button>
            <button className="icon-button" onClick={onResetIndexedDb} disabled={loading}>
              Reset IndexedDB
            </button>
            <button className="icon-button" onClick={onClearCaches} disabled={loading}>
              Clear caches
            </button>
            <button className="icon-button" onClick={onUnregisterServiceWorkers} disabled={loading}>
              Reset service workers
            </button>
          </div>
        </div>

        {message && <div className="modal-message">{message}</div>}
      </div>
    </ModalFrame>
  );
}

export function App() {
  const [route, navigateRoute] = useRoute();
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authToken, setAuthToken] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeHost, setActiveHost] = useState(() => readLocalStorageString(DEVICE_FILTER_STORAGE_KEY, "all"));
  const [activeProvider, setActiveProvider] = useState(() => readLocalStorageString(PROVIDER_FILTER_STORAGE_KEY, "all"));
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [eventState, setEventState] = useState<EventState>({ sessionId: null, events: [] });
  const [query, setQuery] = useState("");
  const [visibleSessionLimit, setVisibleSessionLimit] = useState(SIDEBAR_SESSION_PAGE_SIZE);
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [statusText, setStatusText] = useState("Loading cache");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 780px)").matches);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [groupByProject, setGroupByProject] = useState(() => readLocalStorageBoolean(GROUP_BY_PROJECT_STORAGE_KEY, true));
  const [draft, setDraft] = useState("");
  const [settings, setSettings] = useState<AppSettingsInfo | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [audioItems, setAudioItems] = useState<ImportedAudioInfo[]>([]);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [audioLanguage, setAudioLanguage] = useState<TranscriptLanguage>("ru");
  const [audioRetryingId, setAudioRetryingId] = useState("");
  const [audioUploadStatus, setAudioUploadStatus] = useState("");
  const [cachedAudioRecordings, setCachedAudioRecordings] = useState<CachedAudioRecording[]>([]);
  const [recordingState, setRecordingState] = useState<RecordingUiState>({
    active: false,
    elapsedMs: 0,
    chunkCount: 0,
    mimeType: "",
    error: "",
  });
  const syncing = useRef(false);
  const cachedAudioUploadRunning = useRef(false);
  const cachedAudioRecoveryStarted = useRef(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recordingChunkIndexRef = useRef(0);
  const recordingChunkWritesRef = useRef<Promise<void>[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const activeRef = useRef<SessionInfo | null>(null);
  const eventStateRef = useRef<EventState>({ sessionId: null, events: [] });
  const sessionsRef = useRef<SessionInfo[]>([]);
  const activeYDocId = useRef<string | null>(null);
  const yDocs = useRef(new Map<string, Y.Doc>());
  const ySocket = useRef<WebSocket | null>(null);
  const yPushTimers = useRef(new Map<string, number>());
  const isAuthenticated = authState === "authenticated";
  const settingsOpen = route.panel === "settings";
  const audioOpen = route.panel === "audio";
  const activeId = active?.id ?? null;
  const events = eventState.sessionId === activeId ? eventState.events : [];

  const openPanel = useCallback(
    (panel: RoutePanel) => {
      navigateRoute({ chatId: activeId ?? route.chatId, panel });
    },
    [activeId, navigateRoute, route.chatId],
  );

  const closePanel = useCallback(() => {
    navigateRoute({ chatId: route.chatId ?? activeId ?? undefined }, { replace: true });
  }, [activeId, navigateRoute, route.chatId]);

  const resizeSidebarBy = useCallback((delta: number) => {
    setSidebarWidth((current) => clampSidebarWidth(current + delta));
  }, []);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH));
  }, []);

  const beginSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarRef.current?.getBoundingClientRect().width ?? sidebarWidth;

      const onPointerMove = (moveEvent: PointerEvent) => {
        setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
      };
      const onPointerUp = () => {
        document.body.classList.remove("resizing-sidebar");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      };

      document.body.classList.add("resizing-sidebar");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [sidebarWidth],
  );

  const handleSidebarResizeKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        resizeSidebarBy(-16);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        resizeSidebarBy(16);
      } else if (event.key === "Home") {
        event.preventDefault();
        setSidebarWidth(MIN_SIDEBAR_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        setSidebarWidth(sidebarWidthLimit());
      }
    },
    [resizeSidebarBy],
  );

  const appShellStyle = useMemo(
    () => ({ "--sidebar-width": `${sidebarWidth}px` }) as CSSProperties,
    [sidebarWidth],
  );

  const setActiveSession = useCallback((next: SessionInfo | null) => {
    setActive((current) => {
      if (current === null && next === null) return current;
      if (current === null || next === null) return next;
      if (current.id !== next.id) return next;
      return shallowEqualObject(current, next) ? current : next;
    });
  }, []);

  const setSessionEvents = useCallback((sessionId: string | null, nextEvents: SessionEvent[]) => {
    setEventState({ sessionId, events: nextEvents });
  }, []);

  const checkAuth = useCallback(async () => {
    const started = performance.now();
    void logClientEvent("debug", "auth.status.start", null, { online: navigator.onLine }, ["auth"]).catch(() => {});
    try {
      const response = await fetch("/api/auth/status");
      if (!response.ok) throw new Error(`auth status failed: ${response.status}`);
      const payload = (await response.json()) as { configured?: boolean; authenticated?: boolean };
      setAuthConfigured(Boolean(payload.configured));
      setAuthState(payload.authenticated ? "authenticated" : "anonymous");
      setAuthError(payload.configured ? "" : "WEB_TOKEN is not configured on the server.");
      void logClientEvent(
        "info",
        "auth.status.complete",
        null,
        {
          durationMs: Math.round(performance.now() - started),
          configured: Boolean(payload.configured),
          authenticated: Boolean(payload.authenticated),
        },
        ["auth"],
      ).catch(() => {});
    } catch (error) {
      setAuthState("anonymous");
      setAuthError("Could not reach the auth endpoint.");
      void logClientEvent(
        "error",
        "auth.status.failed",
        error instanceof Error ? error.message : String(error),
        { durationMs: Math.round(performance.now() - started), error },
        ["auth"],
      ).catch(() => {});
      console.error(error);
    }
  }, []);

  const login = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!authToken.trim() || authBusy) return;

      setAuthBusy(true);
      setAuthError("");
      const started = performance.now();
      void logClientEvent("info", "auth.login.start", null, { online: navigator.onLine }, ["auth"]).catch(() => {});
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: authToken }),
        });

        if (!response.ok) {
          setAuthError(response.status === 503 ? "WEB_TOKEN is not configured on the server." : "Token is not valid.");
          setAuthState("anonymous");
          void logClientEvent(
            "warn",
            "auth.login.failed",
            `login rejected: ${response.status}`,
            { durationMs: Math.round(performance.now() - started), status: response.status },
            ["auth"],
          ).catch(() => {});
          return;
        }

        setAuthToken("");
        setAuthState("authenticated");
        setAuthConfigured(true);
        void logClientEvent(
          "info",
          "auth.login.complete",
          null,
          { durationMs: Math.round(performance.now() - started) },
          ["auth"],
        ).catch(() => {});
      } catch (error) {
        setAuthError("Login failed.");
        void logClientEvent(
          "error",
          "auth.login.failed",
          error instanceof Error ? error.message : String(error),
          { durationMs: Math.round(performance.now() - started), error },
          ["auth"],
        ).catch(() => {});
        console.error(error);
      } finally {
        setAuthBusy(false);
      }
    },
    [authBusy, authToken],
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch((error) => console.error(error));
    ySocket.current?.close();
    ySocket.current = null;
    activeYDocId.current = null;
    setHosts([]);
    setSessions([]);
    setActive(null);
    setSessionEvents(null, []);
    setDraft("");
    cachedAudioRecoveryStarted.current = false;
    setAuthState("anonymous");
  }, [setSessionEvents]);

  const refreshSettings = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const [nextSettings, nextStats] = await Promise.all([
        fetchJson<AppSettingsInfo>("/api/app/settings"),
        loadCacheStats(),
      ]);
      setSettings(nextSettings);
      setCacheStats(nextStats);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not load settings");
    } finally {
      setSettingsBusy(false);
    }
  }, []);

  const copyText = useCallback(async (value: string) => {
    await navigator.clipboard.writeText(value);
    setSettingsMessage("Copied");
  }, []);

  const createImportToken = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      await fetchJson("/api/imports/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "iPhone Shortcut" }),
      });
      await refreshSettings();
      setSettingsMessage("Token created");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not create token");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const checkOpenRouter = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const nextSettings = await fetchJson<AppSettingsInfo["openRouter"]>("/api/app/openrouter/check", { method: "POST" });
      setSettings((current) => (current ? { ...current, openRouter: nextSettings } : current));
      setSettingsMessage(nextSettings.status === "ok" ? "OpenRouter check passed" : nextSettings.message ?? "OpenRouter check failed");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not check OpenRouter");
    } finally {
      setSettingsBusy(false);
    }
  }, []);

  const resetIndexedDb = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      await resetIndexedDbCache();
      setHosts([]);
      setSessions([]);
      setSessionEvents(null, []);
      setActive(null);
      setDraft("");
      setCachedAudioRecordings([]);
      navigateRoute({}, { replace: true });
      await refreshSettings();
      setSettingsMessage("IndexedDB cache reset");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not reset IndexedDB");
    } finally {
      setSettingsBusy(false);
    }
  }, [navigateRoute, refreshSettings, setSessionEvents]);

  const clearCaches = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const count = await clearBrowserCaches();
      await refreshSettings();
      setSettingsMessage(`Cleared ${count} browser caches`);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not clear caches");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const resetServiceWorkers = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const count = await unregisterServiceWorkers();
      await refreshSettings();
      setSettingsMessage(`Unregistered ${count} service workers`);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not reset service workers");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const refreshAudio = useCallback(async () => {
    setAudioLoading(true);
    setAudioError("");
    try {
      setAudioItems(await fetchJson<ImportedAudioInfo[]>("/api/imports/audio"));
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Could not load audio");
    } finally {
      setAudioLoading(false);
    }
  }, []);

  const refreshCachedAudioRecordings = useCallback(async () => {
    try {
      setCachedAudioRecordings(await loadCachedAudioRecordings());
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Could not load cached recordings");
    }
  }, []);

  const uploadAudioFiles = useCallback(
    async (files: File[]) => {
      const audioFiles = files.filter(isAudioLikeFile);
      if (!audioFiles.length) {
        setAudioUploadStatus("No audio files selected");
        return;
      }

      setAudioUploadStatus(`Uploading ${audioFiles.length} file${audioFiles.length === 1 ? "" : "s"}`);
      setAudioError("");
      try {
        const form = new FormData();
        for (const file of audioFiles) form.append("audio", file, file.name);
        form.append("source", "browser-file-upload");
        form.append("clientNow", new Date().toISOString());
        const result = await fetchJson<{ audioFiles?: number; mediaFiles?: number }>("/api/imports/audio/upload", {
          method: "POST",
          body: form,
        });
        setAudioUploadStatus(`Uploaded ${result.audioFiles ?? result.mediaFiles ?? audioFiles.length} audio file(s)`);
        await refreshAudio();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not upload audio";
        setAudioError(message);
        setAudioUploadStatus(message);
      }
    },
    [refreshAudio],
  );

  const flushCachedAudioUploads = useCallback(async () => {
    if (!isAuthenticated || cachedAudioUploadRunning.current) return;
    cachedAudioUploadRunning.current = true;
    setAudioError("");
    try {
      const records = await loadCachedAudioRecordings();
      setCachedAudioRecordings(records);
      for (const record of records) {
        if (record.id === recordingIdRef.current || record.status === "uploading") continue;
        await markCachedAudioRecordingStatus(record.id, "uploading");
        await refreshCachedAudioRecordings();
        setAudioUploadStatus(`Uploading cached ${record.filename}`);

        try {
          const blob = await loadCachedAudioBlob(record.id);
          const filename = record.filename || `recording-${record.createdAt}.${extensionForMime(blob.type || record.mimeType)}`;
          const form = new FormData();
          form.append("audio", blob, filename);
          form.append("source", "browser-recording");
          form.append("recordingId", record.id);
          form.append("recordedAt", record.createdAt);
          form.append("durationMs", String(record.durationMs));
          await fetchJson("/api/imports/audio/upload", { method: "POST", body: form });
          await deleteCachedAudioRecording(record.id);
          setAudioUploadStatus(`Uploaded cached ${filename}`);
          await refreshAudio();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not upload cached recording";
          await markCachedAudioRecordingStatus(record.id, "failed", message);
          setAudioUploadStatus(message);
        } finally {
          await refreshCachedAudioRecordings();
        }
      }
    } finally {
      cachedAudioUploadRunning.current = false;
    }
  }, [isAuthenticated, refreshAudio, refreshCachedAudioRecordings]);

  const stopAudioRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state !== "inactive") {
      try {
        recorder.requestData();
      } catch {
        // Some browsers do not allow requestData while stopping.
      }
      recorder.stop();
    }
  }, []);

  const startAudioRecording = useCallback(async () => {
    if (mediaRecorderRef.current?.state === "recording") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecordingState((current) => ({ ...current, error: "Audio recording is not available in this browser" }));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = chooseRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const cached = await createCachedAudioRecording(recorder.mimeType || mimeType || "audio/webm");
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingIdRef.current = cached.id;
      recordingStartedAtRef.current = Date.now();
      recordingChunkIndexRef.current = 0;
      recordingChunkWritesRef.current = [];
      setAudioUploadStatus("");
      setRecordingState({
        active: true,
        elapsedMs: 0,
        chunkCount: 0,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        error: "",
      });
      await refreshCachedAudioRecordings();

      recorder.ondataavailable = (event) => {
        if (!event.data.size || !recordingIdRef.current) return;
        const index = recordingChunkIndexRef.current;
        recordingChunkIndexRef.current += 1;
        const elapsedMs = Date.now() - recordingStartedAtRef.current;
        const write = appendCachedAudioChunk(recordingIdRef.current, index, event.data, elapsedMs).catch((error) => {
          setRecordingState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "Could not cache recording chunk",
          }));
        });
        recordingChunkWritesRef.current.push(write);
        setRecordingState((current) => ({ ...current, elapsedMs, chunkCount: index + 1 }));
      };
      recorder.onerror = (event) => {
        setRecordingState((current) => ({
          ...current,
          error: (event as ErrorEvent).message || "Recording failed",
        }));
      };
      recorder.onstop = () => {
        const recordingId = recordingIdRef.current;
        const elapsedMs = Date.now() - recordingStartedAtRef.current;
        if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        recordingStreamRef.current = null;
        recordingIdRef.current = null;
        const chunkWrites = recordingChunkWritesRef.current;
        recordingChunkWritesRef.current = [];
        setRecordingState((current) => ({ ...current, active: false, elapsedMs }));
        if (recordingId) {
          void Promise.allSettled(chunkWrites)
            .then(() => finalizeCachedAudioRecording(recordingId, elapsedMs))
            .then(refreshCachedAudioRecordings)
            .then(flushCachedAudioUploads)
            .catch((error) => {
              setRecordingState((current) => ({
                ...current,
                error: error instanceof Error ? error.message : "Could not finalize recording",
              }));
            });
        }
      };
      recorder.start(1000);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingState((current) => ({ ...current, elapsedMs: Date.now() - recordingStartedAtRef.current }));
      }, 1000);
    } catch (error) {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      setRecordingState((current) => ({
        ...current,
        active: false,
        error: error instanceof Error ? error.message : "Could not start audio recording",
      }));
    }
  }, [flushCachedAudioUploads, refreshCachedAudioRecordings]);

  const toggleAudioRecording = useCallback(() => {
    if (recordingState.active) stopAudioRecording();
    else void startAudioRecording();
  }, [recordingState.active, startAudioRecording, stopAudioRecording]);

  const retryAudioTranscription = useCallback(
    async (mediaId: string, options: AudioRetryOptions) => {
      setAudioRetryingId(mediaId);
      setAudioError("");
      try {
        await fetchJson<AudioTranscriptionInfo>("/api/imports/audio/transcriptions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mediaId, ...options }),
        });
        await refreshAudio();
      } catch (error) {
        setAudioError(error instanceof Error ? error.message : "Could not queue transcription");
      } finally {
        setAudioRetryingId("");
      }
    },
    [refreshAudio],
  );

  const deleteAudio = useCallback(
    async (mediaId: string) => {
      if (!window.confirm("Delete this audio and its transcriptions?")) return;
      setAudioRetryingId(mediaId);
      setAudioError("");
      try {
        await fetchJson(`/api/imports/audio?mediaId=${encodeURIComponent(mediaId)}`, { method: "DELETE" });
        setAudioItems((current) => current.filter((item) => item.id !== mediaId));
      } catch (error) {
        setAudioError(error instanceof Error ? error.message : "Could not delete audio");
      } finally {
        setAudioRetryingId("");
      }
    },
    [],
  );

  const insertTranscriptIntoDraft = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value) return;
      const nextDraft = draft.trim() ? `${draft.trim()}\n\n${value}` : value;
      const docId = activeId ? docIdForSession(activeId) : null;
      const doc = docId ? yDocs.current.get(docId) : null;
      if (doc) setYDraft(doc, nextDraft);
      else setDraft(nextDraft);
      closePanel();
    },
    [activeId, closePanel, draft],
  );

  const refreshCache = useCallback(async (options: { apply?: boolean } = {}) => {
    const started = performance.now();
    const slowTimer = window.setTimeout(() => {
      void logClientEvent(
        "warn",
        "cache.refresh.slow",
        "browser cache refresh is still running",
        { durationMs: Math.round(performance.now() - started) },
        ["cache"],
      ).catch(() => {});
    }, 2500);
    try {
      const [nextHosts, nextSessions] = await Promise.all([loadHosts(), loadSessions()]);
      if (options.apply !== false) {
        setHosts((current) => (sameEntityList(current, nextHosts, (host) => host.agentId) ? current : nextHosts));
        setSessions((current) => (sameEntityList(current, nextSessions, (session) => session.id) ? current : nextSessions));
      }
      const durationMs = Math.round(performance.now() - started);
      if (durationMs > 500 || nextHosts.length || nextSessions.length) {
        void logClientEvent(
          "info",
          "cache.refresh.complete",
          null,
          { durationMs, hosts: nextHosts.length, sessions: nextSessions.length },
          ["cache"],
        ).catch(() => {});
      }
      return { hosts: nextHosts, sessions: nextSessions };
    } catch (error) {
      void logClientEvent(
        "error",
        "cache.refresh.failed",
        error instanceof Error ? error.message : String(error),
        { durationMs: Math.round(performance.now() - started), error },
        ["cache"],
      ).catch(() => {});
      throw error;
    } finally {
      window.clearTimeout(slowTimer);
    }
  }, []);

  const syncNow = useCallback(async (options: SyncNowOptions = {}) => {
    if (!isAuthenticated) return;
    if (syncing.current) return;
    const silent = options.silent === true;
    const metadataOnly = options.metadataOnly !== false;
    syncing.current = true;
    const started = performance.now();
    if (!silent) {
      setSyncState("syncing");
      setStatusText(metadataOnly ? "Refreshing metadata" : "Syncing");
      void logClientEvent("debug", "sync.start", null, { online: navigator.onLine, metadataOnly }, ["sync"]).catch(() => {});
    }
    try {
      const result = await pullUpdates({
        metadataOnly,
        maxBatches: 4,
        onProgress: ({ events, batches, hasMore }) => {
          if (!events && !metadataOnly) return;
          if (!silent || hasMore) {
            setSyncState("syncing");
            setStatusText(
              metadataOnly
                ? "Refreshing metadata"
                : hasMore
                ? `Syncing ${events.toLocaleString()} events (${batches} batches)…`
                : `Applying ${events.toLocaleString()} events…`,
            );
          }
        },
      });
      const shouldRefreshCache =
        !silent || result.events > 0 || result.hasMore || result.hosts > 0 || result.sessions > 0 || result.metadataFull;
      let refreshedSessions = sessionsRef.current;
      if (shouldRefreshCache) {
        if (metadataOnly) {
          try {
            refreshedSessions = (await withTimeout(refreshCache(), 1200, "metadata cache refresh timed out")).sessions;
          } catch (error) {
            void logClientEvent(
              "warn",
              "cache.metadata_refresh.fallback",
              error instanceof Error ? error.message : String(error),
              { durationMs: Math.round(performance.now() - started) },
              ["cache", "sync"],
            ).catch(() => {});
            const shell = await fetchSessionMetadata();
            setHosts((current) => (sameEntityList(current, shell.hosts, (host) => host.agentId) ? current : shell.hosts));
            setSessions((current) => (sameEntityList(current, shell.sessions, (session) => session.id) ? current : shell.sessions));
            void cacheShell(shell.hosts, shell.sessions).catch(() => {});
            refreshedSessions = shell.sessions;
            void logClientEvent(
              "info",
              "read.metadata.fallback.complete",
              null,
              { source: shell.source, hosts: shell.hosts.length, sessions: shell.sessions.length },
              ["read", "cache", "sync"],
            ).catch(() => {});
          }
        } else {
          refreshedSessions = (await refreshCache()).sessions;
        }
      }
      const current = activeRef.current;
      let activeRemoved = false;
      if (current) {
        const fresh = refreshedSessions.find((session) => session.id === current.id);
        if (!fresh || fresh.deletedAt) {
          const docId = activeYDocId.current;
          if (docId) {
            yDocs.current.delete(docId);
            activeYDocId.current = null;
          }
          setActiveSession(null);
          setSessionEvents(null, []);
          setDraft("");
          activeRemoved = true;
          if (parseRoute().chatId === current.id) navigateRoute({}, { replace: true });
          console.warn("active session no longer available", current.id);
        } else if (metadataOnly) {
          setActiveSession(fresh);
        } else if (result.touchedSessionIds.includes(current.id)) {
          const loadedSessionId = current.id;
          const nextEvents = await loadSessionEvents(loadedSessionId);
          if (activeRef.current?.id === loadedSessionId) setSessionEvents(loadedSessionId, nextEvents);
        }
      }
      const durationMs = Math.round(performance.now() - started);
      if (result.events || result.hasMore || durationMs > 1000) {
        void logClientEvent(
          "info",
          "sync.complete",
          null,
          {
            durationMs,
            events: result.events,
            batches: result.batches,
            hosts: result.hosts,
            sessions: result.sessions,
            cursor: result.cursor,
            hasMore: result.hasMore,
            metadataOnly,
            activeRemoved,
          },
          ["sync"],
        ).catch(() => {});
      }
      if (!silent || result.events || result.hasMore || activeRemoved) {
        setSyncState("idle");
        setStatusText(
          activeRemoved
            ? "Active chat was removed"
            : result.hasMore
              ? `Synced ${result.events.toLocaleString()} events, more pending`
              : metadataOnly
                ? "Metadata refreshed"
              : result.events
                ? `Synced ${result.events.toLocaleString()} events`
                : "Up to date",
        );
      } else {
        setSyncState((currentState) => (currentState === "syncing" ? "idle" : currentState));
      }
    } catch (error) {
      if (error instanceof SyncAuthError) {
        cachedAudioRecoveryStarted.current = false;
        setAuthState("anonymous");
        setAuthError("Session expired. Enter the token again.");
      }
      setSyncState(navigator.onLine ? "error" : "offline");
      setStatusText(navigator.onLine ? "Sync failed" : "Offline cache");
      void logClientEvent(
        "error",
        "sync.failed",
        error instanceof Error ? error.message : String(error),
        { durationMs: Math.round(performance.now() - started), error },
        ["sync"],
      ).catch(() => {});
      console.error(error);
    } finally {
      syncing.current = false;
      void flushClientLogs().catch(() => {});
    }
  }, [isAuthenticated, navigateRoute, refreshCache, setActiveSession, setSessionEvents]);

  useEffect(() => {
    installClientLogHandlers();
    void logClientEvent(
      "info",
      "app.boot",
      null,
      {
        route: parseRoute(),
        online: navigator.onLine,
        visibilityState: document.visibilityState,
      },
      ["app"],
    ).catch(() => {});
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void flushClientLogs().catch(() => {});
    const id = window.setInterval(() => {
      void flushClientLogs().catch(() => {});
    }, 10000);
    const onOnline = () => {
      void flushClientLogs().catch(() => {});
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", onOnline);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (settingsOpen) refreshSettings();
  }, [refreshSettings, settingsOpen]);

  useEffect(() => {
    if (audioOpen) refreshAudio();
  }, [audioOpen, refreshAudio]);

  useEffect(() => {
    if (audioOpen) refreshCachedAudioRecordings();
  }, [audioOpen, refreshCachedAudioRecordings]);

  useEffect(() => {
    if (!isAuthenticated || cachedAudioRecoveryStarted.current) return;
    cachedAudioRecoveryStarted.current = true;
    void refreshCachedAudioRecordings().then(flushCachedAudioUploads);
  }, [flushCachedAudioUploads, isAuthenticated, refreshCachedAudioRecordings]);

  useEffect(() => {
    if (!audioOpen) return;
    const hasPending = audioItems.some((item) =>
      item.transcriptions.some((transcription) => transcription.status === "queued" || transcription.status === "processing"),
    );
    if (!hasPending) return;
    const id = window.setInterval(refreshAudio, 4000);
    return () => window.clearInterval(id);
  }, [audioItems, audioOpen, refreshAudio]);

  useEffect(() => {
    const flushActiveRecording = () => {
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "recording") {
        try {
          recorder.requestData();
        } catch {
          return;
        }
      }
    };
    document.addEventListener("visibilitychange", flushActiveRecording);
    window.addEventListener("beforeunload", flushActiveRecording);
    return () => {
      document.removeEventListener("visibilitychange", flushActiveRecording);
      window.removeEventListener("beforeunload", flushActiveRecording);
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    getMeta<"light" | "dark">("theme").then((stored) => {
      const next = stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      setTheme(next);
      document.documentElement.dataset.theme = next;
    });
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    let disposed = false;
    const started = performance.now();
    setSyncState("loading");
    setStatusText("Loading chat list");
    const stuckTimer = window.setTimeout(() => {
      if (disposed) return;
      setSyncState("error");
      setStatusText("Chat list is taking too long");
      void logClientEvent(
        "error",
        "cache.initial_hydrate.stuck",
        "initial chat list hydrate did not finish",
        { durationMs: Math.round(performance.now() - started) },
        ["cache", "startup"],
      ).catch(() => {});
    }, 20000);
    withTimeout(refreshCache({ apply: false }), 1200, "browser cache hydrate timed out")
      .catch(async (error) => {
        if (disposed) throw error;
        setStatusText("Loading latest chat list");
        void logClientEvent(
          "warn",
          "cache.initial_hydrate.fallback",
          error instanceof Error ? error.message : String(error),
          { durationMs: Math.round(performance.now() - started), fallback: "read-api-metadata" },
          ["cache", "startup"],
        ).catch(() => {});
        const shell = await fetchSessionMetadata();
        if (disposed) return shell;
        setHosts((current) => (sameEntityList(current, shell.hosts, (host) => host.agentId) ? current : shell.hosts));
        setSessions((current) => (sameEntityList(current, shell.sessions, (session) => session.id) ? current : shell.sessions));
        void cacheShell(shell.hosts, shell.sessions).catch((cacheError) => {
          void logClientEvent(
            "warn",
            "cache.shell_write.failed",
            cacheError instanceof Error ? cacheError.message : String(cacheError),
            { error: cacheError },
            ["cache"],
          ).catch(() => {});
        });
        return shell;
      })
      .then((shell) => {
        if (disposed) return;
        window.clearTimeout(stuckTimer);
        setHosts((current) => (sameEntityList(current, shell.hosts, (host) => host.agentId) ? current : shell.hosts));
        setSessions((current) => (sameEntityList(current, shell.sessions, (session) => session.id) ? current : shell.sessions));
        void logClientEvent(
          "info",
          "cache.initial_hydrate.complete",
          null,
          {
            durationMs: Math.round(performance.now() - started),
            hosts: shell.hosts.length,
            sessions: shell.sessions.length,
            readSource: "source" in shell ? shell.source : "indexeddb",
          },
          ["cache", "startup"],
        ).catch(() => {});
        void syncNow({ silent: true, metadataOnly: true });
      })
      .catch((error) => {
        if (disposed) return;
        window.clearTimeout(stuckTimer);
        setSyncState(navigator.onLine ? "error" : "offline");
        setStatusText(navigator.onLine ? "Browser cache failed" : "Offline cache failed");
        console.error(error);
      });
    return () => {
      disposed = true;
      window.clearTimeout(stuckTimer);
    };
  }, [isAuthenticated, refreshCache, syncNow]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    eventStateRef.current = eventState;
  }, [eventState]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!isAuthenticated) return;

    if (!sessions.length) {
      setActiveSession(null);
      return;
    }

    if (route.chatId) {
      const routedSession = sessions.find((session) => session.id === route.chatId) ?? null;
      if (routedSession) {
        setActiveSession(routedSession);
        return;
      }

      const fallback = sessions[0];
      setActiveSession(fallback);
      navigateRoute({ chatId: fallback.id, panel: route.panel }, { replace: true });
      return;
    }

    setActiveSession(sessions[0]);
  }, [isAuthenticated, navigateRoute, route.chatId, route.panel, sessions, setActiveSession]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const socket = openYjsSocket(async (docId, update) => {
      const doc = yDocs.current.get(docId);
      if (doc) {
        Y.applyUpdate(doc, update, "remote");
        await persistDraftDoc(docId, doc);
        if (activeYDocId.current === docId) setDraft(getDraft(doc));
      } else {
        await mergeCachedDraftUpdate(docId, update);
      }
    });
    ySocket.current = socket;
    return () => {
      socket.close();
      ySocket.current = null;
    };
  }, [isAuthenticated]);

  const scheduleYjsPush = useCallback((docId: string, sessionDbId: string, doc: Y.Doc, update: Uint8Array) => {
    sendYjsSocketUpdate(ySocket.current, docId, sessionDbId, update);
    const current = yPushTimers.current.get(docId);
    if (current) window.clearTimeout(current);
    const timer = window.setTimeout(() => {
      yPushTimers.current.delete(docId);
      syncDraftDoc(docId, sessionDbId, doc, true).catch((error) => console.error(error));
    }, 500);
    yPushTimers.current.set(docId, timer);
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of yPushTimers.current.values()) window.clearTimeout(timer);
      yPushTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setMeta("theme", theme);
  }, [theme]);

  useEffect(() => {
    writeLocalStorageValue(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    writeLocalStorageValue(GROUP_BY_PROJECT_STORAGE_KEY, groupByProject ? "true" : "false");
  }, [groupByProject]);

  useEffect(() => {
    writeLocalStorageValue(PROVIDER_FILTER_STORAGE_KEY, activeProvider);
  }, [activeProvider]);

  useEffect(() => {
    writeLocalStorageValue(DEVICE_FILTER_STORAGE_KEY, activeHost);
  }, [activeHost]);

  useEffect(() => {
    const onResize = () => setSidebarWidth((current) => clampSidebarWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!activeId) {
      setSessionEvents(null, []);
      activeYDocId.current = null;
      setDraft("");
      return;
    }
    const loadForSessionId = activeId;
    let disposed = false;
    setEventState((current) =>
      current.sessionId === loadForSessionId ? current : { sessionId: loadForSessionId, events: [] },
    );
    withTimeout(loadSessionEvents(loadForSessionId), 1000, "cached session events timed out")
      .catch((error) => {
        void logClientEvent(
          "warn",
          "cache.session_events.fallback",
          error instanceof Error ? error.message : String(error),
          { sessionId: loadForSessionId, expectedEvents: activeRef.current?.eventCount ?? null },
          ["cache", "session"],
        ).catch(() => {});
        return [] as SessionEvent[];
      })
      .then(async (cachedEvents) => {
        if (disposed || activeRef.current?.id !== loadForSessionId) return;
        const currentEvents = eventStateRef.current;
        const hasLiveEvents = currentEvents.sessionId === loadForSessionId && currentEvents.events.length > 0;
        if (cachedEvents.length && !hasLiveEvents) setSessionEvents(loadForSessionId, cachedEvents);
        const expectedEvents = activeRef.current?.eventCount ?? 0;
        if (hasLiveEvents && currentEvents.events.length >= expectedEvents && expectedEvents > 0) {
          return;
        }
        if (cachedEvents.length >= expectedEvents && expectedEvents > 0) {
          void logClientEvent(
            "debug",
            "read.session_events.cache_hit",
            null,
            { sessionId: loadForSessionId, cachedEvents: cachedEvents.length, expectedEvents },
            ["read", "cache", "session"],
          ).catch(() => {});
          return;
        }
        if (navigator.onLine === false) {
          void logClientEvent(
            "info",
            "read.session_events.offline_cache",
            null,
            { sessionId: loadForSessionId, cachedEvents: cachedEvents.length, expectedEvents },
            ["read", "cache", "session"],
          ).catch(() => {});
          return;
        }

        const readStarted = performance.now();
        void logClientEvent(
          "debug",
          "read.session_events.start",
          null,
          { sessionId: loadForSessionId, cachedEvents: cachedEvents.length, expectedEvents },
          ["read", "session"],
        ).catch(() => {});
        const payload = await fetchSessionEvents(loadForSessionId);
        if (disposed || activeRef.current?.id !== loadForSessionId) return;
        const sessionForCache = payload.session ?? activeRef.current;
        if (payload.session) setActiveSession(payload.session);
        setSessionEvents(loadForSessionId, payload.events);
        if (sessionForCache) {
          void cacheSessionPayload({ session: sessionForCache, events: payload.events }).catch((cacheError) => {
            void logClientEvent(
              "warn",
              "cache.session_write.failed",
              cacheError instanceof Error ? cacheError.message : String(cacheError),
              { sessionId: loadForSessionId, events: payload.events.length, error: cacheError },
              ["cache", "session"],
            ).catch(() => {});
          });
        }
        void logClientEvent(
          "info",
          "read.session_events.complete",
          null,
          {
            sessionId: loadForSessionId,
            source: payload.source,
            events: payload.events.length,
            durationMs: Math.round(performance.now() - readStarted),
          },
          ["read", "session"],
        ).catch(() => {});
      })
      .catch((error) => {
        void logClientEvent(
          "error",
          "read.session_events.failed",
          error instanceof Error ? error.message : String(error),
          { sessionId: loadForSessionId, error },
          ["read", "session"],
        ).catch(() => {});
        console.error(error);
      });
    return () => {
      disposed = true;
    };
  }, [activeId, active?.eventCount, isAuthenticated, setActiveSession, setSessionEvents]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!activeId) return;
    const sessionDbId = activeId;
    const docId = docIdForSession(sessionDbId);
    let disposed = false;
    let cleanup: (() => void) | null = null;
    activeYDocId.current = docId;

    loadDraftDoc(docId)
      .then(async (doc) => {
        if (disposed) return;
        yDocs.current.set(docId, doc);
        setDraft(getDraft(doc));
        subscribeYjsSocket(ySocket.current, [docId]);

        const onUpdate = (update: Uint8Array, origin: unknown) => {
          persistDraftDoc(docId, doc).catch((error) => console.error(error));
          if (activeYDocId.current === docId) setDraft(getDraft(doc));
          if (origin !== "remote" && origin !== "cache") scheduleYjsPush(docId, sessionDbId, doc, update);
        };

        doc.on("update", onUpdate);
        cleanup = () => doc.off("update", onUpdate);
        await syncDraftDoc(docId, sessionDbId, doc, true);
        if (!disposed) setDraft(getDraft(doc));

        if (disposed) cleanup();
      })
      .catch((error) => console.error(error));

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [activeId, isAuthenticated, scheduleYjsPush]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const id = window.setInterval(() => {
      if (!document.hidden) syncNow({ silent: true, metadataOnly: true });
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) syncNow({ silent: true, metadataOnly: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    const onOnline = () => syncNow({ silent: true, metadataOnly: true });
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [isAuthenticated, syncNow]);

  const duplicateHostnames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const host of hosts) counts.set(host.hostname, (counts.get(host.hostname) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([hostname]) => hostname));
  }, [hosts]);

  const providerOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      const provider = providerFilterValue(session);
      counts.set(provider, (counts.get(provider) ?? 0) + 1);
    }
    const preferredOrder = ["claude", "codex", "gemini", "legacy", "v2", "unknown"];
    const values = [...counts.keys()].sort((a, b) => {
      const ai = preferredOrder.indexOf(a);
      const bi = preferredOrder.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? preferredOrder.length : ai) - (bi === -1 ? preferredOrder.length : bi);
      return providerLabel(a).localeCompare(providerLabel(b));
    });
    return [
      { value: "all", label: "All", count: sessions.length },
      ...values.map((value) => ({ value, label: providerLabel(value), count: counts.get(value) ?? 0 })),
    ];
  }, [sessions]);

  const deviceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) counts.set(session.agentId, (counts.get(session.agentId) ?? 0) + 1);
    return [
      { value: "all", label: "All devices", count: sessions.length, title: "All devices" },
      ...hosts.map((host) => ({
        value: host.agentId,
        label: hostLabel(host.hostname, host.agentId, duplicateHostnames),
        count: counts.get(host.agentId) ?? host.sessionCount,
        title: `${host.hostname}\n${host.agentId}${host.sourceRoot ? `\n${host.sourceRoot}` : ""}`,
      })),
    ];
  }, [duplicateHostnames, hosts, sessions]);

  useEffect(() => {
    if (activeProvider === "all") return;
    if (!providerOptions.some((option) => option.value === activeProvider)) setActiveProvider("all");
  }, [activeProvider, providerOptions]);

  useEffect(() => {
    if (activeHost === "all") return;
    if (!hosts.some((host) => host.agentId === activeHost)) setActiveHost("all");
  }, [activeHost, hosts]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (activeHost !== "all" && session.agentId !== activeHost) return false;
      if (activeProvider !== "all" && providerFilterValue(session) !== activeProvider) return false;
      if (!q) return true;
      return [
        session.hostname,
        session.agentId,
        session.projectName,
        session.projectKey,
        session.title,
        session.sessionId,
        session.sourcePath,
        session.sourceProvider,
        session.sourceKind,
        session.sourceGeneration,
        session.gitBranch,
        session.gitCommit,
        session.gitRemoteUrl,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [activeHost, activeProvider, query, sessions]);

  useEffect(() => {
    setVisibleSessionLimit(SIDEBAR_SESSION_PAGE_SIZE);
  }, [activeHost, activeProvider, groupByProject, query]);

  const visibleSessions = useMemo(() => {
    const visible = filteredSessions.slice(0, visibleSessionLimit);
    const activeSession = active ? filteredSessions.find((session) => session.id === active.id) : undefined;
    if (!activeSession || visible.some((session) => session.id === activeSession.id)) return visible;
    return [activeSession, ...visible];
  }, [active, filteredSessions, visibleSessionLimit]);

  const hiddenSessionCount = Math.max(0, filteredSessions.length - visibleSessions.length);
  const items = useMemo(() => groupItems(flatten(events)), [events]);
  const yDocIdsToKeepWarm = useMemo(() => sessions.slice(0, 20).map((session) => docIdForSession(session.id)), [sessions]);
  const groupedSessions = useMemo(() => {
    if (!groupByProject) {
      return [{ key: "recent", title: "Recent", sessions: visibleSessions, total: filteredSessions.length }];
    }
    const grouped = new Map<string, { title: string; sessions: SessionInfo[]; total: number }>();
    const totals = new Map<string, number>();
    for (const session of filteredSessions) {
      const key = session.projectName || session.projectKey || "unknown";
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    for (const session of visibleSessions) {
      const key = session.projectName || session.projectKey || "unknown";
      const group = grouped.get(key) ?? { title: key, sessions: [], total: totals.get(key) ?? 0 };
      group.sessions.push(session);
      grouped.set(key, group);
    }
    const lastSeen = (list: SessionInfo[]) =>
      list.reduce((acc, s) => (s.lastSeenAt > acc ? s.lastSeenAt : acc), "");
    return [...grouped.entries()]
      .map(([key, group]) => ({ key, ...group }))
      .sort((a, b) => lastSeen(b.sessions).localeCompare(lastSeen(a.sessions)));
  }, [filteredSessions, groupByProject, visibleSessions]);

  const selectSession = useCallback((session: SessionInfo) => {
    setActiveSession(session);
    navigateRoute({ chatId: session.id });
    if (window.matchMedia("(max-width: 780px)").matches) setSidebarOpen(false);
  }, [navigateRoute, setActiveSession]);

  const handleSessionListScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (hiddenSessionCount <= 0) return;
      const target = event.currentTarget;
      const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (remaining > 260) return;
      setVisibleSessionLimit((limit) => Math.min(filteredSessions.length, limit + SIDEBAR_SESSION_PAGE_SIZE));
    },
    [filteredSessions.length, hiddenSessionCount],
  );

  useEffect(() => {
    if (!isAuthenticated) return;
    const topSessions = sessions.slice(0, 20);
    if (!topSessions.length) return;
    syncCachedDraftDocs(topSessions).catch((error) => console.error(error));
  }, [isAuthenticated, sessions]);

  useEffect(() => {
    if (!isAuthenticated) return;
    subscribeYjsSocket(ySocket.current, yDocIdsToKeepWarm);
  }, [isAuthenticated, yDocIdsToKeepWarm]);

  if (!isAuthenticated) {
    return (
      <div className="auth-page">
        <form className="auth-panel" onSubmit={login}>
          <div className="auth-brand">Chatview</div>
          <label className="auth-label" htmlFor="chatview-token">
            Token
          </label>
          <input
            id="chatview-token"
            className="auth-input"
            type="password"
            value={authToken}
            onChange={(event) => setAuthToken(event.target.value)}
            placeholder={authState === "checking" ? "Checking session" : "Enter token"}
            autoFocus
            autoComplete="current-password"
            disabled={authState === "checking" || authBusy || !authConfigured}
          />
          {authError && <div className="auth-error">{authError}</div>}
          <button className="auth-button" disabled={authState === "checking" || authBusy || !authConfigured || !authToken.trim()}>
            {authBusy ? "Signing in" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-closed"}`} style={appShellStyle}>
      <header className="topbar">
        <div className="top-left">
          <button className="icon-button menu-button" onClick={() => setSidebarOpen((open) => !open)} title="Toggle chats">
            Chats
          </button>
          <div>
            <div className="brand">Chatview</div>
            {active && <div className="active-inline">{active.hostname} / {active.projectName}</div>}
          </div>
        </div>
        <div className="top-status">
          <div className={`sync-line ${syncState}`}>{statusText}</div>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={() => openPanel("audio")} title="Uploaded audio">
            Audio
          </button>
          <button className="icon-button" onClick={() => openPanel("settings")} title="Settings">
            Settings
          </button>
          <a className="icon-button download-button" href="/api/agent/download?arch=arm64">
            Download Mac Agent (M1)
          </a>
          <button
            className="icon-button"
            onClick={() => syncNow({ metadataOnly: true })}
            disabled={syncState === "syncing"}
            title="Sync now"
          >
            Sync
          </button>
          <button
            className="icon-button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            title="Toggle theme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button className="icon-button" onClick={logout} title="Sign out">
            Logout
          </button>
        </div>
      </header>

      <div className="layout">
        {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close chats" />}
        <aside className="sidebar" ref={sidebarRef}>
          <div
            className="sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            tabIndex={0}
            onPointerDown={beginSidebarResize}
            onKeyDown={handleSidebarResizeKey}
          />

          <div className="filter-panel">
            <input
              className="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              autoCapitalize="none"
            />

            <div className="filter-section">
              <div className="filter-label">
                <span>Source</span>
                <span>{filteredSessions.length.toLocaleString()}</span>
              </div>
              <div className="filter-grid">
                {providerOptions.map((option) => (
                  <button
                    key={option.value}
                    className={`filter-chip ${activeProvider === option.value ? "active" : ""}`}
                    onClick={() => setActiveProvider(option.value)}
                  >
                    <span>{option.label}</span>
                    <b>{option.count.toLocaleString()}</b>
                  </button>
                ))}
              </div>
            </div>

            <label className="filter-section">
              <div className="filter-label">
                <span>Device</span>
                <span>{activeHost === "all" ? "all" : shortId(activeHost)}</span>
              </div>
              <select className="filter-select" value={activeHost} onChange={(event) => setActiveHost(event.target.value)}>
                {deviceOptions.map((option) => (
                  <option key={option.value} value={option.value} title={option.title}>
                    {option.label} ({option.count.toLocaleString()})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="device-strip">
            {deviceOptions.map((option) => (
              <button
                key={option.value}
                className={`host-chip ${activeHost === option.value ? "active" : ""}`}
                onClick={() => setActiveHost(option.value)}
                title={option.title}
              >
                {option.label}
                <span>{option.count.toLocaleString()}</span>
              </button>
            ))}
          </div>

          <div className="session-list" onScroll={handleSessionListScroll}>
            {groupedSessions.map((group) => (
              <div key={group.key} className="session-group">
                <div className="session-group-head">
                  <span>{group.title}</span>
                  <span>
                    {group.sessions.length}
                    {group.total > group.sessions.length ? `/${group.total}` : ""}
                  </span>
                </div>
                {group.sessions.map((session) => (
                  <button
                    key={session.id}
                    className={`session-item ${active?.id === session.id ? "active" : ""}`}
                    onClick={() => selectSession(session)}
                    title={sessionSourceTitle(session)}
                  >
                    <span className="session-title">{session.title || session.sessionId.slice(0, 8)}</span>
                    <span className="session-meta">
                      {sourceProviderLabel(session)} · {hostLabel(session.hostname, session.agentId, duplicateHostnames)} ·{" "}
                      {session.eventCount.toLocaleString()}
                    </span>
                    <span className="session-source">
                      {sourceGenerationLabel(session) ? `${sourceGenerationLabel(session)} · ` : ""}
                      {session.sourcePath}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {hiddenSessionCount > 0 && (
              <div className="session-group">
                <div className="session-group-head">
                  Showing {visibleSessions.length.toLocaleString()} of {filteredSessions.length.toLocaleString()}
                </div>
                <button
                  className="icon-button compact-button"
                  onClick={() => setVisibleSessionLimit((limit) => limit + SIDEBAR_SESSION_PAGE_SIZE)}
                >
                  Load more
                </button>
              </div>
            )}
          </div>
        </aside>

        <main className="main">
          {!active && <div className="empty">No cached chats yet</div>}
          {active && (
            <div className="chat">
              <div className="chat-head">
                <div>
                  <div className="chat-title">{active.title || active.sessionId}</div>
                  <div className="chat-subtitle">
                    {sourceProviderLabel(active)} / {active.projectName} / {hostLabel(active.hostname, active.agentId, duplicateHostnames)}
                  </div>
                  <div className="chat-source" title={sessionSourceTitle(active)}>
                    <span className="source-pill">{active.id.startsWith("v2:") ? "v2" : "legacy"}</span>
                    {sourceGenerationLabel(active) && <span className="source-pill">{sourceGenerationLabel(active)}</span>}
                    <span className="chat-source-path">{active.sourcePath}</span>
                  </div>
                </div>
                <div className="chat-count">{events.length}</div>
              </div>

              <VirtualChat items={items} resetKey={active.id} />

              <div className="composer">
                <textarea
                  value={draft}
                  onChange={(event) => {
                    const docId = activeId ? docIdForSession(activeId) : null;
                    const doc = docId ? yDocs.current.get(docId) : null;
                    if (doc) setYDraft(doc, event.target.value);
                    else setDraft(event.target.value);
                  }}
                  placeholder="Reply..."
                  rows={2}
                />
                <button className="send-button" disabled title="UI only for now">
                  Send
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          cacheStats={cacheStats}
          loading={settingsBusy}
          message={settingsMessage}
          onClose={closePanel}
          onRefresh={refreshSettings}
          onCopy={copyText}
          onCreateToken={createImportToken}
          onCheckOpenRouter={checkOpenRouter}
          onResetIndexedDb={resetIndexedDb}
          onClearCaches={clearCaches}
          onUnregisterServiceWorkers={resetServiceWorkers}
          groupByProject={groupByProject}
          sidebarWidth={sidebarWidth}
          onGroupByProjectChange={setGroupByProject}
          onResetSidebarWidth={resetSidebarWidth}
        />
      )}
      {audioOpen && (
        <AudioModal
          items={audioItems}
          loading={audioLoading}
          error={audioError}
          language={audioLanguage}
          busyMediaId={audioRetryingId}
          uploadStatus={audioUploadStatus}
          recording={recordingState}
          cachedRecordings={cachedAudioRecordings}
          models={settings?.transcriptionModels?.length ? settings.transcriptionModels : FALLBACK_TRANSCRIPTION_MODELS}
          reasoningEfforts={settings?.reasoningEfforts?.length ? settings.reasoningEfforts : FALLBACK_REASONING_EFFORTS}
          onLanguage={setAudioLanguage}
          onRefresh={refreshAudio}
          onUploadFiles={uploadAudioFiles}
          onFlushCache={flushCachedAudioUploads}
          onToggleRecording={toggleAudioRecording}
          onRetry={retryAudioTranscription}
          onDelete={deleteAudio}
          onInsert={insertTranscriptIntoDraft}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
