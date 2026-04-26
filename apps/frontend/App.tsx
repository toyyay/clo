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
  loadSessions,
  resetIndexedDbCache,
  setMeta,
  unregisterServiceWorkers,
  type CacheStats,
} from "./db";
import { AudioModal, FALLBACK_REASONING_EFFORTS, FALLBACK_TRANSCRIPTION_MODELS } from "./audio-panel";
import { fetchJson, sameEntityList, shallowEqualObject, withTimeout } from "./app-utils";
import { AuthPage } from "./auth-page";
import type { AuthState, EventState, SyncHealth, SyncNowOptions, SyncState } from "./app-types";
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
import { useSessionEventsCache } from "./use-session-events-cache";
import { useStartupCache } from "./use-startup-cache";
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

const HEALTH_REFRESH_MS = 30_000;

export function App() {
  const [route, navigateRoute] = useRoute();
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authToken, setAuthToken] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [buildSha, setBuildSha] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [eventState, setEventState] = useState<EventState>({ sessionId: null, events: [] });
  const [query, setQuery] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [statusText, setStatusText] = useState("Loading cache");
  const [syncHealth, setSyncHealth] = useState<SyncHealth>(() => ({
    online: navigator.onLine,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  }));
  const [now, setNow] = useState(() => Date.now());
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
  const pendingIngest = useRef(false);
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
  const canShowLocalApp = authState !== "anonymous";
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

  const markServerAttempt = useCallback(() => {
    const timestampMs = Date.now();
    const timestamp = new Date(timestampMs).toISOString();
    setSyncHealth((current) => {
      if (!shouldRefreshHealthTimestamp(current.lastAttemptAt, timestampMs) && current.online === navigator.onLine) return current;
      return { ...current, online: navigator.onLine, lastAttemptAt: timestamp };
    });
  }, []);

  const markServerReachable = useCallback(() => {
    const timestampMs = Date.now();
    const timestamp = new Date(timestampMs).toISOString();
    setSyncHealth((current) => {
      if (
        !current.lastError &&
        current.online === navigator.onLine &&
        current.lastSuccessAt &&
        !shouldRefreshHealthTimestamp(current.lastSuccessAt, timestampMs)
      ) {
        return current;
      }
      return {
        ...current,
        online: navigator.onLine,
        lastAttemptAt: current.lastAttemptAt ?? timestamp,
        lastSuccessAt: timestamp,
        lastError: null,
      };
    });
  }, []);

  const markServerError = useCallback((error: unknown) => {
    const timestamp = new Date().toISOString();
    setSyncHealth((current) => ({
      ...current,
      online: navigator.onLine,
      lastAttemptAt: timestamp,
      lastError: errorMessage(error),
    }));
  }, []);

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

  const ensureSessionEventsTarget = useCallback((sessionId: string) => {
    setEventState((current) => (current.sessionId === sessionId ? current : { sessionId, events: [] }));
  }, []);

  const clearActiveLocalSession = useCallback(() => {
    setSessionEvents(null, []);
    activeYDocId.current = null;
    setDraft("");
  }, [setSessionEvents]);

  const refreshActiveSessionEvents = useCallback(async (sessionId: string, reason: string, cachedEvents: number, expectedEvents: number) => {
    if (navigator.onLine === false) return false;
    const readStarted = performance.now();
    void logClientEvent(
      "debug",
      "read.session_events.start",
      null,
      { sessionId, cachedEvents, expectedEvents, reason },
      ["read", "session"],
    ).catch(() => {});
    markServerAttempt();
    const payload = await fetchSessionEvents(sessionId);
    if (activeRef.current?.id !== sessionId) return false;
    markServerReachable();
    const sessionForCache = payload.session ?? activeRef.current;
    if (payload.session) setActiveSession(payload.session);
    setSessionEvents(sessionId, payload.events);
    if (sessionForCache) {
      void cacheSessionPayload({ session: sessionForCache, events: payload.events }).catch((cacheError) => {
        void logClientEvent(
          "warn",
          "cache.session_write.failed",
          cacheError instanceof Error ? cacheError.message : String(cacheError),
          { sessionId, events: payload.events.length, error: cacheError },
          ["cache", "session"],
        ).catch(() => {});
      });
    }
    void logClientEvent(
      "info",
      "read.session_events.complete",
      null,
      {
        sessionId,
        source: payload.source,
        events: payload.events.length,
        durationMs: Math.round(performance.now() - readStarted),
        reason,
      },
      ["read", "session"],
    ).catch(() => {});
    return true;
  }, [markServerAttempt, markServerReachable, setActiveSession, setSessionEvents]);

  const checkAuth = useCallback(async () => {
    const started = performance.now();
    markServerAttempt();
    void logClientEvent("debug", "auth.status.start", null, { online: navigator.onLine }, ["auth"]).catch(() => {});
    try {
      const response = await fetch("/api/auth/status");
      if (!response.ok) throw new Error(`auth status failed: ${response.status}`);
      const payload = (await response.json()) as { configured?: boolean; authenticated?: boolean };
      markServerReachable();
      setAuthConfigured(Boolean(payload.configured));
      setAuthState((current) => (payload.authenticated ? "authenticated" : current === "authenticated" ? current : "anonymous"));
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
      markServerError(error);
      const cachedSessions = await withTimeout(loadSessions(), 2500, "auth fallback cache read timed out").catch(() => []);
      if (cachedSessions.length) {
        setAuthConfigured(true);
        setAuthState((current) => (current === "authenticated" ? current : "cache"));
        setAuthError("");
        setSyncState(navigator.onLine ? "error" : "offline");
        setStatusText(navigator.onLine ? "Backend issue; showing cache" : "Offline cache");
      } else {
        setAuthState("anonymous");
        setAuthError("Could not reach the auth endpoint.");
      }
      void logClientEvent(
        cachedSessions.length ? "warn" : "error",
        "auth.status.failed",
        error instanceof Error ? error.message : String(error),
        { durationMs: Math.round(performance.now() - started), cachedSessions: cachedSessions.length, online: navigator.onLine, error },
        ["auth"],
      ).catch(() => {});
      console.error(error);
    }
  }, [markServerAttempt, markServerError, markServerReachable]);

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
      void logClientEvent(
        "debug",
        "sync.queued",
        null,
        { requested: options, merged: pendingSync.current, activeId: activeRef.current?.id ?? null },
        ["sync"],
      ).catch(() => {});
      return;
    }
    const silent = options.silent === true;
    const metadataOnly = options.metadataOnly !== false;
    const eventMode = metadataOnly ? undefined : options.eventMode;
    syncing.current = true;
    const started = performance.now();
    markServerAttempt();
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
      markServerReachable();
      const shouldRefreshCache =
        !silent || result.events > 0 || result.hasMore || result.hosts > 0 || result.sessions > 0 || result.metadataFull;
      void logClientEvent(
        result.events || result.sessions || result.hosts || result.hasMore || !metadataOnly ? "info" : "debug",
        "sync.result",
        null,
        {
          durationMs: Math.round(performance.now() - started),
          metadataOnly,
          requestedEventMode: eventMode ?? null,
          resultEventMode: result.eventMode ?? null,
          events: result.events,
          batches: result.batches,
          hosts: result.hosts,
          sessions: result.sessions,
          hasMore: result.hasMore,
          backfillHasMore: result.backfillHasMore,
          touchedSessionIds: result.touchedSessionIds,
          activeId: activeRef.current?.id ?? null,
          activeLoadedEvents:
            eventStateRef.current.sessionId === activeRef.current?.id ? eventStateRef.current.events.length : null,
          shouldRefreshCache,
          cursor: result.cursor,
          metadataCursor: result.metadataCursor,
        },
        ["sync"],
      ).catch(() => {});
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
          const loadedEvents = eventStateRef.current.sessionId === current.id ? eventStateRef.current.events.length : 0;
          const activeMetadataChanged = !shallowEqualObject(current, fresh);
          setActiveSession(fresh);
          void logClientEvent(
            "debug",
            "active.metadata_checked",
            null,
            {
              sessionId: current.id,
              loadedEvents,
              previousEventCount: current.eventCount,
              freshEventCount: fresh.eventCount,
              activeMetadataChanged,
              willRefresh:
                navigator.onLine !== false &&
                (fresh.eventCount > loadedEvents || (activeMetadataChanged && loadedEvents > 0 && fresh.eventCount >= loadedEvents)),
            },
            ["sync", "session"],
          ).catch(() => {});
          if (
            navigator.onLine !== false &&
            (fresh.eventCount > loadedEvents || (activeMetadataChanged && loadedEvents > 0 && fresh.eventCount >= loadedEvents))
          ) {
            try {
              await refreshActiveSessionEvents(current.id, "metadata_changed", loadedEvents, fresh.eventCount);
            } catch (error) {
              markServerError(error);
              void logClientEvent(
                "warn",
                "read.session_events.metadata_refresh_failed",
                error instanceof Error ? error.message : String(error),
                { sessionId: current.id, cachedEvents: loadedEvents, expectedEvents: fresh.eventCount, error },
                ["read", "session", "sync"],
              ).catch(() => {});
            }
          }
        } else if (result.touchedSessionIds.includes(current.id)) {
          await refreshActiveSessionEvents(
            current.id,
            "sync_touched_session",
            eventStateRef.current.sessionId === current.id ? eventStateRef.current.events.length : 0,
            fresh.eventCount,
          );
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
        markServerReachable();
        setAuthState("anonymous");
        setAuthError("Session expired. Enter the token again.");
      } else {
        markServerError(error);
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
  }, [
    isAuthenticated,
    markServerAttempt,
    markServerError,
    markServerReachable,
    navigateRoute,
    refreshCache,
    setActiveSession,
    setSessionEvents,
  ]);

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
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, 30_000);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useStartupCache({
    authState,
    canShowLocalApp,
    isAuthenticated,
    checkAuth,
    refreshCache,
    setAuthState,
    setHosts,
    setSessions,
    setSyncHealth,
    setSyncState,
    setStatusText,
    syncNow,
  });

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    let disposed = false;
    fetch("/api/health", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`health failed: ${response.status}`);
        return (await response.json()) as { commit_sha?: string };
      })
      .then((payload) => {
        if (!disposed) setBuildSha(payload.commit_sha ?? null);
      })
      .catch(() => {
        if (!disposed) setBuildSha(null);
      });
    return () => {
      disposed = true;
    };
  }, []);

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
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    eventStateRef.current = eventState;
  }, [eventState]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!canShowLocalApp) return;

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
  }, [canShowLocalApp, navigateRoute, route.chatId, route.panel, sessions, setActiveSession]);

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
    if (!isAuthenticated || navigator.onLine === false) return;
    sendYjsSocketUpdate(ySocket.current, docId, sessionDbId, update);
    const current = yPushTimers.current.get(docId);
    if (current) window.clearTimeout(current);
    const timer = window.setTimeout(() => {
      yPushTimers.current.delete(docId);
      syncDraftDoc(docId, sessionDbId, doc, true).catch((error) => console.error(error));
    }, 500);
    yPushTimers.current.set(docId, timer);
  }, [isAuthenticated]);

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

  useSessionEventsCache({
    activeId,
    expectedEventCount: active?.eventCount,
    authState,
    canShowLocalApp,
    isAuthenticated,
    activeRef,
    eventStateRef,
    ensureSessionEventsTarget,
    onNoActiveSession: clearActiveLocalSession,
    setSessionEvents,
    syncNow,
    refreshActiveSessionEvents,
    markServerError,
  });

  useEffect(() => {
    if (!canShowLocalApp) return;
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
        if (isAuthenticated) {
          await syncDraftDoc(docId, sessionDbId, doc, true);
          if (!disposed) setDraft(getDraft(doc));
        }

        if (disposed) cleanup();
      })
      .catch((error) => console.error(error));

    return () => {
      disposed = true;
      cleanup?.();
      if (activeYDocId.current === docId) activeYDocId.current = null;
      yDocs.current.delete(docId);
    };
  }, [activeId, canShowLocalApp, isAuthenticated, scheduleYjsPush]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const id = window.setInterval(() => {
      if (!document.hidden) syncNow({ silent: true, metadataOnly: true });
    }, 5000);
    const onVisible = () => {
      if (document.hidden) return;
      if (pendingIngest.current) {
        pendingIngest.current = false;
        void syncNow({ silent: true, metadataOnly: false, eventMode: "forward" });
      }
      void syncNow({ silent: true, metadataOnly: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    const onOnline = () => {
      if (pendingIngest.current) {
        pendingIngest.current = false;
        void syncNow({ silent: true, metadataOnly: false, eventMode: "forward" });
      }
      void syncNow({ silent: true, metadataOnly: true });
    };
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
    const close = openIngestStream({
      onOpen: (_event, readyState) => {
        void logClientEvent(
          "info",
          "stream.open",
          null,
          { readyState, activeId: activeRef.current?.id ?? null, visibilityState: document.visibilityState },
          ["sync", "stream"],
        ).catch(() => {});
      },
      onMessage: (message, readyState) => {
        const activeSession = activeRef.current;
        const activeTouched = Boolean(activeSession && message.sessionIds.includes(activeSession.id));
        const loadedEvents = activeSession && eventStateRef.current.sessionId === activeSession.id ? eventStateRef.current.events.length : 0;
        void logClientEvent(
          "info",
          "stream.ingest.message",
          null,
          {
            readyState,
            streamSeq: message.streamSeq ?? null,
            publishedAt: message.publishedAt ?? null,
            clientCount: message.clientCount ?? null,
            agentId: message.agentId,
            sessionIds: message.sessionIds,
            acceptedEvents: message.acceptedEvents,
            activeId: activeSession?.id ?? null,
            activeTouched,
            activeLoadedEvents: loadedEvents,
            activeExpectedEvents: activeSession?.eventCount ?? null,
            hidden: document.hidden,
            pendingIngest: pendingIngest.current,
          },
          ["sync", "stream"],
        ).catch(() => {});
        if (!message.sessionIds.length && !message.acceptedEvents) return;
        pendingIngest.current = true;
        if (document.hidden) return;
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          pendingIngest.current = false;
          if (message.sessionIds.length) void syncNow({ silent: true, metadataOnly: true });
          void syncNow({ silent: true, metadataOnly: false, eventMode: "forward" });
          if (activeSession && activeTouched) {
            void refreshActiveSessionEvents(activeSession.id, "stream_active_session", loadedEvents, activeSession.eventCount).catch((error) => {
              markServerError(error);
              void logClientEvent(
                "warn",
                "read.session_events.stream_refresh_failed",
                error instanceof Error ? error.message : String(error),
                { sessionId: activeSession.id, cachedEvents: loadedEvents, expectedEvents: activeSession.eventCount, error },
                ["read", "session", "stream"],
              ).catch(() => {});
            });
          }
        }, 300);
      },
      onHeartbeat: (message, readyState) => {
        void logClientEvent(
          "debug",
          "stream.heartbeat",
          null,
          {
            readyState,
            streamSeq: message.streamSeq ?? null,
            sentAt: message.sentAt ?? null,
            clientCount: message.clientCount ?? null,
            activeId: activeRef.current?.id ?? null,
          },
          ["sync", "stream"],
        ).catch(() => {});
      },
      onError: (_event, readyState) => {
        void logClientEvent(
          "warn",
          "stream.ingest.error",
          "ingest stream disconnected",
          {
            readyState,
            readyStateLabel: eventSourceReadyStateLabel(readyState),
            online: navigator.onLine,
            activeId: activeRef.current?.id ?? null,
            visibilityState: document.visibilityState,
          },
          ["sync", "stream"],
        ).catch(() => {});
      },
      onMalformed: (error, data, eventType) => {
        void logClientEvent(
          "warn",
          "stream.message.malformed",
          error instanceof Error ? error.message : String(error),
          { eventType, dataPreview: data.slice(0, 500), activeId: activeRef.current?.id ?? null },
          ["sync", "stream"],
        ).catch(() => {});
      },
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      void logClientEvent(
        "info",
        "stream.close.local",
        null,
        { activeId: activeRef.current?.id ?? null, visibilityState: document.visibilityState },
        ["sync", "stream"],
      ).catch(() => {});
      close();
    };
  }, [isAuthenticated, markServerError, refreshActiveSessionEvents, syncNow]);

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

  if (!canShowLocalApp) {
    return (
      <>
        <AuthPage
          authState={authState}
          authConfigured={authConfigured}
          authToken={authToken}
          authError={authError}
          authBusy={authBusy}
          onTokenChange={setAuthToken}
          onLogin={login}
        />
        <BuildBadge sha={buildSha} />
      </>
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-closed"}`} style={appShellStyle}>
      <BuildBadge sha={buildSha} />
      <Topbar
        active={active}
        syncState={syncState}
        statusText={statusText}
        syncHealth={syncHealth}
        now={now}
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
          now={now}
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
          now={now}
          syncHealth={syncHealth}
          syncState={syncState}
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

function BuildBadge({ sha }: { sha: string | null }) {
  const shortSha = formatBuildSha(sha);
  if (!shortSha) return null;
  return <div className="build-badge" aria-hidden="true">{`build ${shortSha}`}</div>;
}

function formatBuildSha(sha: string | null) {
  const clean = sha?.trim();
  if (!clean || clean === "unknown") return null;
  return clean.slice(0, 8);
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
    if (
      a[i].id !== b[i].id ||
      a[i].lineNo !== b[i].lineNo ||
      a[i].offset !== b[i].offset ||
      a[i].eventType !== b[i].eventType ||
      a[i].role !== b[i].role ||
      a[i].createdAt !== b[i].createdAt ||
      a[i].ingestedAt !== b[i].ingestedAt ||
      !sameRawValue(a[i].raw, b[i].raw)
    ) {
      return false;
    }
  }
  return true;
}

function sameRawValue(a: unknown, b: unknown) {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function eventSourceReadyStateLabel(value: number) {
  if (value === EventSource.CONNECTING) return "connecting";
  if (value === EventSource.OPEN) return "open";
  if (value === EventSource.CLOSED) return "closed";
  return "unknown";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function shouldRefreshHealthTimestamp(value: string | null, now: number) {
  const parsed = value ? Date.parse(value) : NaN;
  return !Number.isFinite(parsed) || now - parsed >= HEALTH_REFRESH_MS;
}
