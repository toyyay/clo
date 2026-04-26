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
} from "react";
import * as Y from "yjs";
import type {
  AppSettingsInfo,
  HostInfo,
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
import { AudioModal, FALLBACK_REASONING_EFFORTS, FALLBACK_TRANSCRIPTION_MODELS } from "./audio-panel";
import { fetchJson, sameEntityList, shallowEqualObject, withTimeout } from "./app-utils";
import { AuthPage } from "./auth-page";
import type { AuthState, EventState, SyncNowOptions, SyncState } from "./app-types";
import { flatten, groupItems } from "./chat-transcript";
import { flushClientLogs, installClientLogHandlers, logClientEvent } from "./client-logs";
import { MainChat } from "./main-chat";
import { parseRoute, useRoute, type RoutePanel } from "./router";
import { sessionDisplayTitle } from "./session-utils";
import { SessionSidebar } from "./session-sidebar";
import { SettingsModal } from "./settings-modal";
import { openIngestStream } from "./stream";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  GROUP_BY_PROJECT_STORAGE_KEY,
  MIN_SIDEBAR_WIDTH,
  readLocalStorageBoolean,
  readSidebarWidth,
  SIDEBAR_WIDTH_STORAGE_KEY,
  sidebarWidthLimit,
  writeLocalStorageValue,
} from "./storage-prefs";
import { fetchSessionEvents, fetchSessionMetadata, pullUpdates, SyncAuthError } from "./sync";
import { useAudioImports } from "./use-audio-imports";
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
import { Topbar } from "./topbar";

export function App() {
  const [route, navigateRoute] = useRoute();
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authToken, setAuthToken] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [eventState, setEventState] = useState<EventState>({ sessionId: null, events: [] });
  const [query, setQuery] = useState("");
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
  const syncing = useRef(false);
  const pendingSync = useRef<SyncNowOptions | null>(null);
  const backfillTimer = useRef<number | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
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
  const audio = useAudioImports({ isAuthenticated, audioOpen });
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
    setEventState((current) => {
      if (current.sessionId === sessionId && sameSessionEvents(current.events, nextEvents)) return current;
      return { sessionId, events: nextEvents };
    });
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
      const cachedSessions = await loadSessions().catch(() => []);
      if (cachedSessions.length && navigator.onLine === false) {
        setAuthConfigured(true);
        setAuthState("authenticated");
        setAuthError("");
        setStatusText("Offline cache");
      } else {
        setAuthState("anonymous");
        setAuthError("Could not reach the auth endpoint.");
      }
      void logClientEvent(
        cachedSessions.length && navigator.onLine === false ? "warn" : "error",
        "auth.status.failed",
        error instanceof Error ? error.message : String(error),
        { durationMs: Math.round(performance.now() - started), cachedSessions: cachedSessions.length, online: navigator.onLine, error },
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
      navigateRoute({ panel: "settings" }, { replace: true });
      await refreshSettings();
      setSettingsMessage("Local data reset");
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
    if (syncing.current) {
      pendingSync.current = mergeSyncOptions(pendingSync.current, options);
      return;
    }
    const silent = options.silent === true;
    const metadataOnly = options.metadataOnly !== false;
    const eventMode = metadataOnly ? undefined : options.eventMode;
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
        eventMode,
        maxBatches: eventMode === "backfill" ? 1 : 4,
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
      const metadataChanged = metadataOnly && (result.hosts > 0 || result.sessions > 0 || result.metadataFull);
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
            eventMode: result.eventMode,
            backfillHasMore: result.backfillHasMore,
            hasMore: result.hasMore,
            metadataOnly,
            activeRemoved,
          },
          ["sync"],
        ).catch(() => {});
      }
      if (!silent || result.events || result.hasMore || activeRemoved || metadataChanged) {
        setSyncState("idle");
        setStatusText(
          activeRemoved
            ? "Active chat was removed"
            : result.hasMore
              ? `Synced ${result.events.toLocaleString()} events, more pending`
              : metadataChanged
                ? `Loaded ${refreshedSessions.length.toLocaleString()} chats`
              : metadataOnly
                ? "Metadata refreshed"
              : result.backfillHasMore
                ? `Synced ${result.events.toLocaleString()} recent events, history pending`
              : result.events
                ? `Synced ${result.events.toLocaleString()} events`
                : "Up to date",
        );
      } else {
        setSyncState((currentState) => (currentState === "syncing" ? "idle" : currentState));
      }
      if (!metadataOnly && result.backfillHasMore && !document.hidden && backfillTimer.current === null) {
        backfillTimer.current = window.setTimeout(() => {
          backfillTimer.current = null;
          void syncNow({ silent: true, metadataOnly: false, eventMode: "backfill" });
        }, result.eventMode === "recent" ? 1000 : 2500);
      }
    } catch (error) {
      if (error instanceof SyncAuthError) {
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
      const pending = pendingSync.current;
      pendingSync.current = null;
      if (pending) window.setTimeout(() => void syncNow(pending), 0);
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
    return () => {
      if (backfillTimer.current !== null) window.clearTimeout(backfillTimer.current);
    };
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
        setSyncState("idle");
        setStatusText(shell.sessions.length ? `Loaded ${shell.sessions.length.toLocaleString()} chats` : "No cached chats yet");
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
        void syncNow({ silent: true, metadataOnly: false, eventMode: "recent" });
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
    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;
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

      socket.addEventListener("open", () => {
        const warmIds = sessionsRef.current.slice(0, 20).map((session) => docIdForSession(session.id));
        subscribeYjsSocket(socket, [...new Set([...yDocs.current.keys(), ...warmIds])]);
      });
      socket.addEventListener("close", () => {
        if (ySocket.current === socket) ySocket.current = null;
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1500);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ySocket.current?.close();
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
        if (cachedEvents.length && cachedEvents.length < expectedEvents) {
          void syncNow({ silent: true, metadataOnly: false, eventMode: "backfill" });
          return;
        }
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
  }, [activeId, active?.eventCount, isAuthenticated, setActiveSession, setSessionEvents, syncNow]);

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
      if (activeYDocId.current === docId) activeYDocId.current = null;
      yDocs.current.delete(docId);
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

  useEffect(() => {
    if (!isAuthenticated) return;
    let timer: number | null = null;
    const close = openIngestStream(
      (message) => {
        if (!message.sessionIds.length && !message.acceptedEvents) return;
        if (document.hidden) return;
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          void syncNow({ silent: true, metadataOnly: false, eventMode: "forward" });
        }, 300);
      },
      () => {
        void logClientEvent("warn", "stream.ingest.error", "ingest stream disconnected", { online: navigator.onLine }, ["sync", "stream"]).catch(() => {});
      },
    );
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      close();
    };
  }, [isAuthenticated, syncNow]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (!q) return true;
      return [
        session.hostname,
        session.agentId,
        session.projectName,
        session.projectKey,
        sessionDisplayTitle(session),
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
  }, [query, sessions]);

  const items = useMemo(() => groupItems(flatten(events)), [events]);
  const yDocIdsToKeepWarm = useMemo(() => sessions.slice(0, 20).map((session) => docIdForSession(session.id)), [sessions]);

  const selectSession = useCallback((session: SessionInfo) => {
    setActiveSession(session);
    navigateRoute({ chatId: session.id });
    if (window.matchMedia("(max-width: 780px)").matches) setSidebarOpen(false);
  }, [navigateRoute, setActiveSession]);

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

  const handleDraftChange = useCallback(
    (value: string) => {
      const docId = activeId ? docIdForSession(activeId) : null;
      const doc = docId ? yDocs.current.get(docId) : null;
      if (doc) setYDraft(doc, value);
      else setDraft(value);
    },
    [activeId],
  );

  if (!isAuthenticated) {
    return (
      <AuthPage
        authState={authState}
        authConfigured={authConfigured}
        authToken={authToken}
        authError={authError}
        authBusy={authBusy}
        onTokenChange={setAuthToken}
        onLogin={login}
      />
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-closed"}`} style={appShellStyle}>
      <Topbar
        active={active}
        syncState={syncState}
        statusText={statusText}
        theme={theme}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onOpenAudio={() => openPanel("audio")}
        onOpenSettings={() => openPanel("settings")}
        onSync={() => syncNow({ metadataOnly: true })}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        onLogout={logout}
      />

      <div className="layout">
        <SessionSidebar
          sidebarOpen={sidebarOpen}
          sidebarRef={sidebarRef}
          active={active}
          query={query}
          sessions={filteredSessions}
          filteredSessionCount={filteredSessions.length}
          groupByProject={groupByProject}
          onClose={() => setSidebarOpen(false)}
          onResizePointerDown={beginSidebarResize}
          onResizeKeyDown={handleSidebarResizeKey}
          onQueryChange={setQuery}
          onSelectSession={selectSession}
        />

        <MainChat
          active={active}
          eventsLength={events.length}
          items={items}
          draft={draft}
          onDraftChange={handleDraftChange}
        />
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
          items={audio.items}
          loading={audio.loading}
          error={audio.error}
          language={audio.language}
          busyMediaId={audio.busyMediaId}
          uploadStatus={audio.uploadStatus}
          recording={audio.recording}
          cachedRecordings={audio.cachedRecordings}
          models={settings?.transcriptionModels?.length ? settings.transcriptionModels : FALLBACK_TRANSCRIPTION_MODELS}
          reasoningEfforts={settings?.reasoningEfforts?.length ? settings.reasoningEfforts : FALLBACK_REASONING_EFFORTS}
          onLanguage={audio.setLanguage}
          onRefresh={audio.refreshAudio}
          onUploadFiles={audio.uploadFiles}
          onFlushCache={audio.flushCachedUploads}
          onToggleRecording={audio.toggleRecording}
          onRetry={audio.retryTranscription}
          onDelete={audio.deleteAudio}
          onInsert={insertTranscriptIntoDraft}
          onClose={closePanel}
        />
      )}
    </div>
  );
}

function mergeSyncOptions(current: SyncNowOptions | null, next: SyncNowOptions): SyncNowOptions {
  return {
    silent: current ? current.silent === true && next.silent === true : next.silent === true,
    metadataOnly: current?.metadataOnly === false || next.metadataOnly === false ? false : true,
    eventMode: mergeSyncEventMode(current?.eventMode, next.eventMode),
  };
}

function mergeSyncEventMode(current?: SyncNowOptions["eventMode"], next?: SyncNowOptions["eventMode"]): SyncNowOptions["eventMode"] {
  if (current === "recent" || next === "recent") return "recent";
  if (current === "forward" || next === "forward") return "forward";
  return current ?? next;
}

function sameSessionEvents(a: SessionEvent[], b: SessionEvent[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || a[i].lineNo !== b[i].lineNo || a[i].offset !== b[i].offset) return false;
  }
  return true;
}
