import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
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
import { pullUpdates, SyncAuthError } from "./sync";
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
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authToken, setAuthToken] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeHost, setActiveHost] = useState("all");
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [query, setQuery] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [statusText, setStatusText] = useState("Loading cache");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 780px)").matches);
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettingsInfo | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [audioOpen, setAudioOpen] = useState(false);
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
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recordingChunkIndexRef = useRef(0);
  const recordingChunkWritesRef = useRef<Promise<void>[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const activeRef = useRef<SessionInfo | null>(null);
  const activeYDocId = useRef<string | null>(null);
  const yDocs = useRef(new Map<string, Y.Doc>());
  const ySocket = useRef<WebSocket | null>(null);
  const yPushTimers = useRef(new Map<string, number>());
  const isAuthenticated = authState === "authenticated";

  const checkAuth = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/status");
      const payload = (await response.json()) as { configured?: boolean; authenticated?: boolean };
      setAuthConfigured(Boolean(payload.configured));
      setAuthState(payload.authenticated ? "authenticated" : "anonymous");
      setAuthError(payload.configured ? "" : "WEB_TOKEN is not configured on the server.");
    } catch (error) {
      setAuthState("anonymous");
      setAuthError("Could not reach the auth endpoint.");
      console.error(error);
    }
  }, []);

  const login = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!authToken.trim() || authBusy) return;

      setAuthBusy(true);
      setAuthError("");
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: authToken }),
        });

        if (!response.ok) {
          setAuthError(response.status === 503 ? "WEB_TOKEN is not configured on the server." : "Token is not valid.");
          setAuthState("anonymous");
          return;
        }

        setAuthToken("");
        setAuthState("authenticated");
        setAuthConfigured(true);
      } catch (error) {
        setAuthError("Login failed.");
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
    setEvents([]);
    setDraft("");
    cachedAudioRecoveryStarted.current = false;
    setAuthState("anonymous");
  }, []);

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
      setEvents([]);
      setActive(null);
      setDraft("");
      setCachedAudioRecordings([]);
      await refreshSettings();
      setSettingsMessage("IndexedDB cache reset");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not reset IndexedDB");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

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
      const docId = active ? docIdForSession(active.id) : null;
      const doc = docId ? yDocs.current.get(docId) : null;
      if (doc) setYDraft(doc, nextDraft);
      else setDraft(nextDraft);
      setAudioOpen(false);
    },
    [active, draft],
  );

  const refreshCache = useCallback(async () => {
    const [nextHosts, nextSessions] = await Promise.all([loadHosts(), loadSessions()]);
    setHosts(nextHosts);
    setSessions(nextSessions);
    setActive((current) => current ?? nextSessions[0] ?? null);
    return { hosts: nextHosts, sessions: nextSessions };
  }, []);

  const syncNow = useCallback(async () => {
    if (!isAuthenticated) return;
    if (syncing.current) return;
    syncing.current = true;
    const started = performance.now();
    setSyncState("syncing");
    setStatusText("Syncing");
    void logClientEvent("debug", "sync.start", null, { online: navigator.onLine }, ["sync"]).catch(() => {});
    try {
      const result = await pullUpdates({
        maxBatches: 4,
        onProgress: ({ events, batches, hasMore }) => {
          if (!events) return;
          setStatusText(
            hasMore
              ? `Syncing ${events.toLocaleString()} events (${batches} batches)…`
              : `Applying ${events.toLocaleString()} events…`,
          );
        },
      });
      const { sessions: refreshedSessions } = await refreshCache();
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
          setActive(null);
          setEvents([]);
          setDraft("");
          activeRemoved = true;
          console.warn("active session no longer available", current.id);
        } else if (result.events > 0) {
          setEvents(await loadSessionEvents(current.id));
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
            cursor: result.cursor,
            hasMore: result.hasMore,
            activeRemoved,
          },
          ["sync"],
        ).catch(() => {});
      }
      setSyncState("idle");
      setStatusText(
        activeRemoved
          ? "Active chat was removed"
          : result.hasMore
            ? `Synced ${result.events.toLocaleString()} events, more pending`
            : result.events
              ? `Synced ${result.events.toLocaleString()} events`
              : "Up to date",
      );
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
  }, [isAuthenticated, refreshCache]);

  useEffect(() => {
    installClientLogHandlers();
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
    refreshCache().then(() => syncNow());
  }, [isAuthenticated, refreshCache, syncNow]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

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
    if (!isAuthenticated) return;
    if (!active) {
      setEvents([]);
      activeYDocId.current = null;
      setDraft("");
      return;
    }
    loadSessionEvents(active.id).then(setEvents);
  }, [active, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!active) return;
    const docId = docIdForSession(active.id);
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
          if (origin !== "remote" && origin !== "cache") scheduleYjsPush(docId, active.id, doc, update);
        };

        doc.on("update", onUpdate);
        cleanup = () => doc.off("update", onUpdate);
        await syncDraftDoc(docId, active.id, doc, true);
        if (!disposed) setDraft(getDraft(doc));

        if (disposed) cleanup();
      })
      .catch((error) => console.error(error));

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [active, isAuthenticated, scheduleYjsPush]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const id = window.setInterval(() => {
      if (!document.hidden) syncNow();
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) syncNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", syncNow);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", syncNow);
    };
  }, [isAuthenticated, syncNow]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (activeHost !== "all" && session.agentId !== activeHost) return false;
      if (!q) return true;
      return [session.hostname, session.projectName, session.title, session.sessionId, session.sourcePath]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [activeHost, query, sessions]);

  const items = useMemo(() => groupItems(flatten(events)), [events]);
  const yDocIdsToKeepWarm = useMemo(() => sessions.slice(0, 20).map((session) => docIdForSession(session.id)), [sessions]);
  const groupedSessions = useMemo(() => {
    const grouped = new Map<string, SessionInfo[]>();
    for (const session of filteredSessions) {
      const key = session.projectName || session.projectKey || "unknown";
      const list = grouped.get(key) ?? [];
      list.push(session);
      grouped.set(key, list);
    }
    const lastSeen = (list: SessionInfo[]) =>
      list.reduce((acc, s) => (s.lastSeenAt > acc ? s.lastSeenAt : acc), "");
    return [...grouped.entries()].sort(([, a], [, b]) => lastSeen(b).localeCompare(lastSeen(a)));
  }, [filteredSessions]);

  const selectSession = useCallback((session: SessionInfo) => {
    setActive(session);
    if (window.matchMedia("(max-width: 780px)").matches) setSidebarOpen(false);
  }, []);

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
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-closed"}`}>
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
          <button className="icon-button" onClick={() => setAudioOpen(true)} title="Uploaded audio">
            Audio
          </button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings">
            Settings
          </button>
          <a className="icon-button download-button" href="/api/agent/download?arch=arm64">
            Download Mac Agent (M1)
          </a>
          <button className="icon-button" onClick={syncNow} disabled={syncState === "syncing"} title="Sync now">
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
        <aside className="sidebar">
          <div className="host-strip">
            <button className={`host-chip ${activeHost === "all" ? "active" : ""}`} onClick={() => setActiveHost("all")}>
              All
              <span>{sessions.length}</span>
            </button>
            {hosts.map((host) => (
              <button
                key={host.agentId}
                className={`host-chip ${activeHost === host.agentId ? "active" : ""}`}
                onClick={() => setActiveHost(host.agentId)}
              >
                {host.hostname}
                <span>{host.sessionCount}</span>
              </button>
            ))}
          </div>

          <input
            className="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            autoCapitalize="none"
          />

          <div className="session-list">
            {groupedSessions.map(([project, projectSessions]) => (
              <div key={project} className="session-group">
                <div className="session-group-head">
                  <span>{project}</span>
                  <span>{projectSessions.length}</span>
                </div>
                {projectSessions.map((session) => (
                  <button
                    key={session.id}
                    className={`session-item ${active?.id === session.id ? "active" : ""}`}
                    onClick={() => selectSession(session)}
                  >
                    <span className="session-title">{session.title || session.sessionId.slice(0, 8)}</span>
                    <span className="session-meta">
                      {session.hostname} / {session.eventCount}
                    </span>
                  </button>
                ))}
              </div>
            ))}
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
                    {active.hostname} / {active.projectName}
                  </div>
                </div>
                <div className="chat-count">{events.length}</div>
              </div>

              <VirtualChat items={items} resetKey={active.id} />

              <div className="composer">
                <textarea
                  value={draft}
                  onChange={(event) => {
                    const docId = active ? docIdForSession(active.id) : null;
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
          onClose={() => setSettingsOpen(false)}
          onRefresh={refreshSettings}
          onCopy={copyText}
          onCreateToken={createImportToken}
          onCheckOpenRouter={checkOpenRouter}
          onResetIndexedDb={resetIndexedDb}
          onClearCaches={clearCaches}
          onUnregisterServiceWorkers={resetServiceWorkers}
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
          onClose={() => setAudioOpen(false)}
        />
      )}
    </div>
  );
}
