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
  SyncExclusionInfo,
  SyncExclusionKind,
} from "../../packages/shared/types";
import {
  clearBrowserCaches,
  cacheSessionEventPage,
  cacheSessionPayload,
  cacheShell,
  cacheMutedSources,
  deleteYjsOutboxUpdates,
  deleteMeta,
  enqueueYjsOutboxUpdate,
  getMeta,
  loadCacheStats,
  loadHosts,
  loadMutedSources,
  loadSessions,
  loadSessionEventsAfter,
  loadSessionEventsBefore,
  loadSessionStats,
  loadYjsOutboxUpdates,
  pruneCacheBefore,
  pruneMutedSources,
  resetIndexedDbCache,
  setMeta,
  type CacheStats,
  type SessionCacheStat,
} from "./db";
import { AudioModal, FALLBACK_REASONING_EFFORTS, FALLBACK_TRANSCRIPTION_MODELS } from "./audio-panel";
import { fetchJson, sameEntityList, shallowEqualObject, withTimeout } from "./app-utils";
import { AuthPage } from "./auth-page";
import type { AuthState, EventState, SyncHealth, SyncNowOptions, SyncState } from "./app-types";
import { flatten, groupItems } from "./chat-transcript";
import { flushClientLogs, installClientLogHandlers, logClientEvent } from "./client-logs";
import { MainChat } from "./main-chat";
import { parseRoute, useRoute, type RoutePanel } from "./router";
import { providerFilterValue, sessionDisplayTitle } from "./session-utils";
import { SessionSidebar } from "./session-sidebar";
import { SettingsModal } from "./settings-modal";
import { openIngestStream } from "./stream";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_INTERFACE_PREFS,
  GROUP_BY_PROJECT_STORAGE_KEY,
  INTERFACE_PREFS_BEFORE_CHANGE_EVENT,
  MIN_SIDEBAR_WIDTH,
  clampInterfacePrefs,
  clampRetentionDays,
  detectAutoDisplayMode,
  effectiveChatWidth,
  readInterfacePrefs,
  readLocalStorageBoolean,
  readRetentionDays,
  readSidebarWidth,
  SIDEBAR_WIDTH_STORAGE_KEY,
  sidebarWidthLimit,
  writeInterfacePrefs,
  writeLocalStorageValue,
  writeRetentionDays,
  type DisplayMode,
  type InterfacePrefs,
} from "./storage-prefs";
import {
  createSyncExclusion,
  fetchSessionEventPage,
  fetchSessionEvents,
  fetchSessionMetadata,
  fetchSyncExclusions,
  pullUpdates,
  restoreSyncExclusion,
  SyncAuthError,
} from "./sync";
import { useAudioImports } from "./use-audio-imports";
import { useSessionEventsCache } from "./use-session-events-cache";
import { resetServiceWorkerUrl, useServiceWorkerLifecycle } from "./sw-client";
import { useStartupCache } from "./use-startup-cache";
import {
  docIdForSession,
  fromBase64,
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
  syncYjsOutboxEntries,
  toBase64,
} from "./yjs";
import { Topbar } from "./topbar";

const HEALTH_REFRESH_MS = 30_000;
const CHAT_EVENT_WINDOW_INITIAL = 360;
const CHAT_EVENT_WINDOW_PAGE = 180;
const CHAT_EVENT_WINDOW_MAX = 720;
const CHAT_FULL_REFRESH_MAX_EVENTS = 700;
const DISPLAY_MODE_MEDIA_QUERIES = ["(monochrome)", "(prefers-contrast: more)", "(update: slow)"];

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
  const [interfacePrefs, setInterfacePrefs] = useState(readInterfacePrefs);
  const [autoDisplayMode, setAutoDisplayMode] = useState<Exclude<DisplayMode, "auto">>(() => detectAutoDisplayMode());
  const [interfacePrefsOpen, setInterfacePrefsOpen] = useState(false);
  const [retentionDays, setRetentionDays] = useState(readRetentionDays);
  const [groupByProject, setGroupByProject] = useState(() => readLocalStorageBoolean(GROUP_BY_PROJECT_STORAGE_KEY, true));
  const [draft, setDraft] = useState("");
  const [settings, setSettings] = useState<AppSettingsInfo | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [mutedSources, setMutedSources] = useState<SyncExclusionInfo[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionCacheStat[]>([]);
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
  const yOutboxFlushing = useRef(false);
  const yReconcileRunning = useRef(false);
  const yReconcileQueued = useRef(false);
  const resumeRecentAfterBackfill = useRef(false);
  const previousRetentionDays = useRef(retentionDays);
  const sessionEventRefreshes = useRef(new Map<string, { generation: number; controller: AbortController }>());
  const sessionPayloadCacheWrites = useRef(new Map<string, Promise<void>>());
  const eventWindowLoads = useRef({ older: false, newer: false });
  const isAuthenticated = authState === "authenticated";
  const canShowLocalApp = authState !== "anonymous";
  const settingsOpen = route.panel === "settings";
  const audioOpen = route.panel === "audio";
  const audio = useAudioImports({ isAuthenticated, audioOpen });
  const serviceWorker = useServiceWorkerLifecycle();
  const offlineShellResetUrl = useMemo(() => resetServiceWorkerUrl(), []);
  const displayedBuildSha = serviceWorker.status.activeVersion ?? buildSha;
  const activeId = active?.id ?? null;
  const events = eventState.sessionId === activeId ? eventState.events : [];
  const resolvedDisplayMode = interfacePrefs.displayMode === "auto" ? autoDisplayMode : interfacePrefs.displayMode;
  const isMutedSession = useMemo(() => mutedSessionMatcher(mutedSources), [mutedSources]);
  const visibleSessions = useMemo(() => sessions.filter((session) => !isMutedSession(session)), [isMutedSession, sessions]);
  const sessionStatsById = useMemo(() => new Map(sessionStats.map((stat) => [stat.sessionId, stat])), [sessionStats]);
  const mutedSummary = useMemo(() => buildMutedSummary(mutedSources), [mutedSources]);

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

  const updateInterfacePrefs = useCallback((patch: Partial<InterfacePrefs>) => {
    setInterfacePrefs((current) => {
      const next = clampInterfacePrefs({ ...current, ...patch });
      if (
        next.displayMode === current.displayMode &&
        next.uiScale === current.uiScale &&
        next.chatScale === current.chatScale &&
        next.density === current.density &&
        next.chatWidth === current.chatWidth
      ) {
        return current;
      }
      window.dispatchEvent(
        new CustomEvent(INTERFACE_PREFS_BEFORE_CHANGE_EVENT, {
          detail: { heightScale: estimateChatHeightScale(current, next) },
        }),
      );
      return next;
    });
  }, []);

  const resetInterfacePrefs = useCallback(() => {
    updateInterfacePrefs(DEFAULT_INTERFACE_PREFS);
  }, [updateInterfacePrefs]);

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
    () =>
      ({
        "--sidebar-width": `${sidebarWidth}px`,
        "--ui-font-scale": String(interfacePrefs.uiScale),
        "--ui-density": String(interfacePrefs.density),
        "--chat-font-scale": String(interfacePrefs.chatScale),
        "--chat-line-width": `${effectiveChatWidth(interfacePrefs, resolvedDisplayMode)}px`,
      }) as CSSProperties,
    [interfacePrefs, resolvedDisplayMode, sidebarWidth],
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

  const setSessionEvents = useCallback((sessionId: string | null, nextEvents: SessionEvent[], options: Partial<EventState> = {}) => {
    setEventState((current) => {
      const next = {
        sessionId,
        events: nextEvents,
        windowed: options.windowed ?? false,
        hasOlder: options.hasOlder ?? false,
        hasNewer: options.hasNewer ?? false,
      } satisfies EventState;
      if (
        current.sessionId === next.sessionId &&
        current.windowed === next.windowed &&
        current.hasOlder === next.hasOlder &&
        current.hasNewer === next.hasNewer &&
        sameSessionEvents(current.events, next.events)
      ) {
        return current;
      }
      return next;
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

  const queueSessionPayloadCache = useCallback((sessionId: string, generation: number, payload: { session: SessionInfo; events: SessionEvent[] }) => {
    const previous = sessionPayloadCacheWrites.current.get(sessionId) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        const latest = sessionEventRefreshes.current.get(sessionId);
        if (latest && latest.generation > generation) return;
        await cacheSessionPayload(payload);
      });
    const tracked = write
      .catch((cacheError) => {
        void logClientEvent(
          "warn",
          "cache.session_write.failed",
          cacheError instanceof Error ? cacheError.message : String(cacheError),
          { sessionId, events: payload.events.length, error: cacheError },
          ["cache", "session"],
        ).catch(() => {});
      })
      .finally(() => {
        if (sessionPayloadCacheWrites.current.get(sessionId) === tracked) sessionPayloadCacheWrites.current.delete(sessionId);
      });
    sessionPayloadCacheWrites.current.set(sessionId, tracked);
  }, []);

  const refreshActiveSessionEvents = useCallback(async (sessionId: string, reason: string, cachedEvents: number, expectedEvents: number) => {
    if (navigator.onLine === false) return false;
    const previousRefresh = sessionEventRefreshes.current.get(sessionId);
    previousRefresh?.controller.abort();
    const generation = (previousRefresh?.generation ?? 0) + 1;
    const controller = new AbortController();
    sessionEventRefreshes.current.set(sessionId, { generation, controller });
    const readStarted = performance.now();
    void logClientEvent(
      "debug",
      "read.session_events.start",
      null,
      { sessionId, cachedEvents, expectedEvents, reason },
      ["read", "session"],
    ).catch(() => {});
    markServerAttempt();
    const isCurrentRefresh = () => {
      const current = sessionEventRefreshes.current.get(sessionId);
      return current?.generation === generation && current.controller === controller;
    };
    try {
      if (sessionId.startsWith("v3:") && expectedEvents > CHAT_FULL_REFRESH_MAX_EVENTS) {
        const payload = await fetchSessionEventPage(
          sessionId,
          { direction: "recent", limit: CHAT_EVENT_WINDOW_INITIAL, init: { signal: controller.signal } },
          retentionDays,
        );
        if (!isCurrentRefresh() || activeRef.current?.id !== sessionId) return false;
        markServerReachable();
        setActiveSession(payload.session);
        setSessionEvents(sessionId, payload.events, {
          windowed: true,
          hasOlder: payload.hasOlder,
          hasNewer: payload.hasNewer,
        });
        void cacheSessionEventPage(payload).catch((cacheError) => {
          void logClientEvent(
            "warn",
            "cache.session_page_write.failed",
            cacheError instanceof Error ? cacheError.message : String(cacheError),
            { sessionId, events: payload.events.length, error: cacheError },
            ["cache", "session"],
          ).catch(() => {});
        });
        void logClientEvent(
          "info",
          "read.session_events.page_complete",
          null,
          {
            sessionId,
            source: payload.source,
            events: payload.events.length,
            expectedEvents,
            durationMs: Math.round(performance.now() - readStarted),
            reason,
            generation,
            hasOlder: payload.hasOlder,
            hasNewer: payload.hasNewer,
          },
          ["read", "session"],
        ).catch(() => {});
        return true;
      }

      const payload = await fetchSessionEvents(sessionId, { signal: controller.signal }, retentionDays);
      if (!isCurrentRefresh() || activeRef.current?.id !== sessionId) return false;
      markServerReachable();
      const sessionForCache = payload.session ?? activeRef.current;
      if (payload.session) setActiveSession(payload.session);
      setSessionEvents(sessionId, payload.events, {
        windowed: false,
        hasOlder: false,
        hasNewer: false,
      });
      if (sessionForCache) queueSessionPayloadCache(sessionId, generation, { session: sessionForCache, events: payload.events });
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
          generation,
        },
        ["read", "session"],
      ).catch(() => {});
      return true;
    } catch (error) {
      if (isAbortError(error) && !isCurrentRefresh()) return false;
      throw error;
    } finally {
      if (isCurrentRefresh()) sessionEventRefreshes.current.delete(sessionId);
    }
  }, [markServerAttempt, markServerReachable, queueSessionPayloadCache, retentionDays, setActiveSession, setSessionEvents]);

  const loadOlderEventWindow = useCallback(async () => {
    const session = activeRef.current;
    const current = eventStateRef.current;
    if (!session || current.sessionId !== session.id || !current.events.length || current.hasOlder === false) return;
    if (eventWindowLoads.current.older) return;
    eventWindowLoads.current.older = true;
    const cursor = current.events[0];
    const canFetchRemote = session.id.startsWith("v3:") && isAuthenticated && navigator.onLine !== false;
    const started = performance.now();
    void logClientEvent(
      "debug",
      "read.session_events.older_start",
      null,
      {
        sessionId: session.id,
        cursorId: cursor.id,
        cursorLineNo: cursor.lineNo ?? null,
        cursorOffset: cursor.offset ?? null,
        visibleEvents: current.events.length,
        expectedEvents: session.eventCount,
        canFetchRemote,
        online: navigator.onLine,
      },
      ["read", "session", "scroll"],
    ).catch(() => {});
    try {
      let source: "indexeddb" | "remote" | "empty" = "indexeddb";
      let older = await loadSessionEventsBefore(session.id, cursor, CHAT_EVENT_WINDOW_PAGE);
      let hasOlder = older.length >= CHAT_EVENT_WINDOW_PAGE;
      if (!older.length && canFetchRemote) {
        const payload = await fetchSessionEventPage(
          session.id,
          { direction: "before", cursor, limit: CHAT_EVENT_WINDOW_PAGE },
          retentionDays,
        );
        older = payload.events;
        hasOlder = payload.hasOlder;
        source = older.length ? "remote" : "empty";
        setActiveSession(payload.session);
        void cacheSessionEventPage(payload).catch(() => {});
      } else if (!older.length) {
        source = "empty";
      }
      setEventState((latest) => {
        if (latest.sessionId !== session.id || latest.events[0]?.id !== cursor.id) return latest;
        if (!older.length) {
          return {
            ...latest,
            hasOlder: canFetchRemote ? false : Boolean(latest.hasOlder && session.eventCount > latest.events.length),
            windowed: latest.windowed || latest.hasNewer || session.eventCount > latest.events.length,
          };
        }
        return mergeEventWindow(latest, older, "prepend", hasOlder);
      });
      void logClientEvent(
        "debug",
        "read.session_events.older_complete",
        null,
        {
          sessionId: session.id,
          cursorId: cursor.id,
          source,
          loadedEvents: older.length,
          hasOlder,
          durationMs: Math.round(performance.now() - started),
          visibleEventsBefore: current.events.length,
        },
        ["read", "session", "scroll"],
      ).catch(() => {});
    } catch (error) {
      void logClientEvent(
        "warn",
        "read.session_events.older_failed",
        error instanceof Error ? error.message : String(error),
        { sessionId: session.id, cursorId: cursor.id, durationMs: Math.round(performance.now() - started), error },
        ["read", "session", "scroll"],
      ).catch(() => {});
    } finally {
      eventWindowLoads.current.older = false;
    }
  }, [isAuthenticated, retentionDays, setActiveSession]);

  const loadNewerEventWindow = useCallback(async (force = false) => {
    const session = activeRef.current;
    const current = eventStateRef.current;
    if (!session || current.sessionId !== session.id || !current.events.length || (!force && current.hasNewer === false)) return;
    if (eventWindowLoads.current.newer) return;
    eventWindowLoads.current.newer = true;
    const cursor = current.events.at(-1)!;
    const canFetchRemote = session.id.startsWith("v3:") && isAuthenticated && navigator.onLine !== false;
    const started = performance.now();
    void logClientEvent(
      "debug",
      "read.session_events.newer_start",
      null,
      {
        sessionId: session.id,
        cursorId: cursor.id,
        cursorLineNo: cursor.lineNo ?? null,
        cursorOffset: cursor.offset ?? null,
        visibleEvents: current.events.length,
        expectedEvents: session.eventCount,
        force,
        canFetchRemote,
        online: navigator.onLine,
      },
      ["read", "session", "scroll"],
    ).catch(() => {});
    try {
      let source: "indexeddb" | "remote" | "empty" = "indexeddb";
      let newer = await loadSessionEventsAfter(session.id, cursor, CHAT_EVENT_WINDOW_PAGE);
      let hasNewer = newer.length >= CHAT_EVENT_WINDOW_PAGE;
      if (!newer.length && canFetchRemote) {
        const payload = await fetchSessionEventPage(
          session.id,
          { direction: "after", cursor, limit: CHAT_EVENT_WINDOW_PAGE },
          retentionDays,
        );
        newer = payload.events;
        hasNewer = payload.hasNewer;
        source = newer.length ? "remote" : "empty";
        setActiveSession(payload.session);
        void cacheSessionEventPage(payload).catch(() => {});
      } else if (!newer.length) {
        source = "empty";
      }
      setEventState((latest) => {
        if (latest.sessionId !== session.id || latest.events.at(-1)?.id !== cursor.id) return latest;
        if (!newer.length) {
          return {
            ...latest,
            hasNewer: canFetchRemote ? false : Boolean(latest.hasNewer && session.eventCount > latest.events.length),
            windowed: latest.windowed || latest.hasOlder || session.eventCount > latest.events.length,
          };
        }
        return mergeEventWindow(latest, newer, "append", hasNewer);
      });
      void logClientEvent(
        "debug",
        "read.session_events.newer_complete",
        null,
        {
          sessionId: session.id,
          cursorId: cursor.id,
          source,
          loadedEvents: newer.length,
          hasNewer,
          force,
          durationMs: Math.round(performance.now() - started),
          visibleEventsBefore: current.events.length,
        },
        ["read", "session", "scroll"],
      ).catch(() => {});
    } catch (error) {
      void logClientEvent(
        "warn",
        "read.session_events.newer_failed",
        error instanceof Error ? error.message : String(error),
        { sessionId: session.id, cursorId: cursor.id, force, durationMs: Math.round(performance.now() - started), error },
        ["read", "session", "scroll"],
      ).catch(() => {});
    } finally {
      eventWindowLoads.current.newer = false;
    }
  }, [isAuthenticated, retentionDays, setActiveSession]);

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
      const [nextSettings, nextStats, nextMuted, nextSessionStats] = await Promise.all([
        fetchJson<AppSettingsInfo>("/api/app/settings"),
        loadCacheStats(),
        isAuthenticated ? fetchSyncExclusions() : loadMutedSources(),
        loadSessionStats(),
      ]);
      setSettings(nextSettings);
      setCacheStats(nextStats);
      setMutedSources(nextMuted);
      setSessionStats(nextSessionStats);
      void cacheMutedSources(nextMuted).catch(() => {});
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not load settings");
    } finally {
      setSettingsBusy(false);
    }
  }, [isAuthenticated]);

  const copyText = useCallback(async (value: string) => {
    try {
      await writeClipboardText(value);
      setSettingsMessage("Copied");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not copy");
    }
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
      setSettingsMessage(`Cleared ${count} Chatview browser caches`);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not clear caches");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const checkServiceWorkerUpdate = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      await serviceWorker.checkForUpdate();
      await refreshSettings();
      setSettingsMessage("Offline update check complete");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not check offline update");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings, serviceWorker]);

  const applyServiceWorkerUpdate = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("Installing offline update");
    try {
      await serviceWorker.applyUpdate();
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not install offline update");
      setSettingsBusy(false);
    }
  }, [serviceWorker]);

  const applyVisibleServiceWorkerUpdate = useCallback(() => {
    void serviceWorker.applyUpdate().catch((error) => {
      setSettingsMessage(error instanceof Error ? error.message : "Could not install offline update");
      console.error(error);
    });
  }, [serviceWorker]);

  const requestPersistentStorage = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      if (!navigator.storage?.persist) {
        setSettingsMessage("This browser does not support persistent storage requests");
        return;
      }
      const persisted = await navigator.storage.persist();
      await refreshSettings();
      setSettingsMessage(persisted ? "Offline storage is persistent" : "Browser kept offline storage as best effort");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not request persistent storage");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const copyResetServiceWorkerLink = useCallback(() => {
    void copyText(offlineShellResetUrl);
  }, [copyText, offlineShellResetUrl]);

  const resetOfflineShell = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("Resetting offline shell");
    try {
      await serviceWorker.resetOfflineShell();
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not reset offline shell");
      setSettingsBusy(false);
    }
  }, [serviceWorker]);

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
      const [nextHosts, nextSessions, nextSessionStats] = await Promise.all([loadHosts(), loadSessions(), loadSessionStats()]);
      if (options.apply !== false) {
        setHosts((current) => (sameEntityList(current, nextHosts, (host) => host.agentId) ? current : nextHosts));
        setSessions((current) => (sameEntityList(current, nextSessions, (session) => session.id) ? current : nextSessions));
      }
      setSessionStats(nextSessionStats);
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
    void logClientEvent(
      "debug",
      "sync.start",
      null,
      {
        reason: options.reason ?? null,
        silent,
        online: navigator.onLine,
        metadataOnly,
        eventMode: eventMode ?? null,
        activeId: activeRef.current?.id ?? null,
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        pendingIngest: pendingIngest.current,
      },
      ["sync"],
    ).catch(() => {});
    if (!silent) {
      setSyncState("syncing");
      setStatusText(metadataOnly ? "Refreshing metadata" : "Syncing");
    }
    try {
      const result = await pullUpdates({
        metadataOnly,
        eventMode,
        lookbackDays: retentionDays,
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
          reason: options.reason ?? null,
          silent,
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
      if (!metadataOnly && eventMode === "recent" && result.eventMode === "backfill") {
        resumeRecentAfterBackfill.current = true;
      } else if (!metadataOnly && result.eventMode === "recent") {
        resumeRecentAfterBackfill.current = false;
      }
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
            const shell = await fetchSessionMetadata(retentionDays);
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
        } else if (result.touchedSessionIds.includes(current.id) && eventStateRef.current.windowed) {
          await loadNewerEventWindow(true);
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
            reason: options.reason ?? null,
            silent,
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
      if (!metadataOnly && result.eventMode === "backfill" && !result.backfillHasMore && resumeRecentAfterBackfill.current) {
        resumeRecentAfterBackfill.current = false;
        window.setTimeout(() => void syncNow({ silent: true, metadataOnly: false, eventMode: "recent", reason: "resume_recent_after_backfill" }), 0);
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
        { durationMs: Math.round(performance.now() - started), reason: options.reason ?? null, silent, error },
        ["sync"],
      ).catch(() => {});
      console.error(error);
    } finally {
      const cutoffIso = retentionCutoffIso(retentionDays);
      if (cutoffIso) void pruneCacheBefore(cutoffIso).catch(() => {});
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
    loadNewerEventWindow,
    refreshCache,
    retentionDays,
    refreshActiveSessionEvents,
    setActiveSession,
    setSessionEvents,
  ]);

  const resetSyncCursorsForMutedChange = useCallback(async () => {
    if (backfillTimer.current !== null) {
      window.clearTimeout(backfillTimer.current);
      backfillTimer.current = null;
    }
    resumeRecentAfterBackfill.current = false;
    await Promise.all([
      deleteMeta("metadataCursor"),
      deleteMeta("backfillCursor"),
      setMeta("backfillHasMore", false),
    ]);
  }, []);

  const refreshMutedSources = useCallback(async () => {
    const nextMuted = isAuthenticated ? await fetchSyncExclusions() : await loadMutedSources();
    setMutedSources(nextMuted);
    await cacheMutedSources(nextMuted);
    await pruneMutedSources(nextMuted);
    await refreshCache();
    setCacheStats(await loadCacheStats());
    setSessionStats(await loadSessionStats());
    return nextMuted;
  }, [isAuthenticated, refreshCache]);

  const muteSource = useCallback(
    async (input: { kind: SyncExclusionKind; targetId: string; label: string; metadata?: Record<string, unknown> }) => {
      if (!isAuthenticated) {
        setSettingsMessage("Connect to the server before muting sources");
        return;
      }
      setSettingsBusy(true);
      setSettingsMessage("");
      try {
        await createSyncExclusion(input);
        await resetSyncCursorsForMutedChange();
        const nextMuted = await refreshMutedSources();
        const current = activeRef.current;
        if (current && mutedSessionMatcher(nextMuted)(current)) {
          setActiveSession(null);
          setSessionEvents(null, []);
          setDraft("");
          if (parseRoute().chatId === current.id) navigateRoute({}, { replace: true });
        }
        setSettingsMessage(`Muted ${input.label}`);
        void syncNow({ silent: true, metadataOnly: true, reason: "mute_source" });
      } catch (error) {
        setSettingsMessage(error instanceof Error ? error.message : "Could not mute source");
      } finally {
        setSettingsBusy(false);
      }
    },
    [isAuthenticated, navigateRoute, refreshMutedSources, resetSyncCursorsForMutedChange, setActiveSession, setSessionEvents, syncNow],
  );

  const restoreMuted = useCallback(
    async (id: string) => {
      if (!isAuthenticated) {
        setSettingsMessage("Connect to the server before restoring sources");
        return;
      }
      setSettingsBusy(true);
      setSettingsMessage("");
      try {
        const restored = await restoreSyncExclusion(id);
        await resetSyncCursorsForMutedChange();
        await refreshMutedSources();
        setSettingsMessage(`Restored ${restored.label ?? restored.targetId}`);
        void syncNow({ silent: true, metadataOnly: true, reason: "restore_muted_source" });
        window.setTimeout(() => void syncNow({ silent: true, metadataOnly: false, eventMode: "recent", reason: "restore_muted_source_recent" }), 0);
      } catch (error) {
        setSettingsMessage(error instanceof Error ? error.message : "Could not restore source");
      } finally {
        setSettingsBusy(false);
      }
    },
    [isAuthenticated, refreshMutedSources, resetSyncCursorsForMutedChange, syncNow],
  );

  const muteDevice = useCallback(
    (agentId: string, label: string) => {
      const affected = sessions.filter((session) => session.agentId === agentId);
      void muteSource({
        kind: "device",
        targetId: agentId,
        label,
        metadata: mutedMetadataForSessions(affected, sessionStatsById),
      });
    },
    [muteSource, sessions, sessionStatsById],
  );

  const muteProvider = useCallback(
    (agentId: string, provider: string, label: string) => {
      const affected = sessions.filter((session) => session.agentId === agentId && providerFilterValue(session) === provider);
      void muteSource({
        kind: "provider",
        targetId: `${agentId}:${provider}`,
        label,
        metadata: { provider, ...mutedMetadataForSessions(affected, sessionStatsById) },
      });
    },
    [muteSource, sessions, sessionStatsById],
  );

  const muteSession = useCallback(
    (session: SessionInfo) => {
      const stat = sessionStatsById.get(session.id);
      void muteSource({
        kind: "session",
        targetId: session.id,
        label: sessionDisplayTitle(session),
        metadata: {
          agentId: session.agentId,
          hostname: session.hostname,
          provider: providerFilterValue(session),
          projectKey: session.projectKey,
          approxBytes: stat?.approxBytes ?? session.sizeBytes ?? 0,
          eventCount: stat?.eventCount ?? session.eventCount,
          sessionCount: 1,
        },
      });
    },
    [muteSource, sessionStatsById],
  );

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
    retentionDays,
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
    let disposed = false;
    Promise.all([
      isAuthenticated ? fetchSyncExclusions() : loadMutedSources(),
      loadSessionStats(),
    ])
      .then(([nextMuted, nextStats]) => {
        if (disposed) return;
        setMutedSources(nextMuted);
        setSessionStats(nextStats);
        void cacheMutedSources(nextMuted).catch(() => {});
        void pruneMutedSources(nextMuted).catch(() => {});
      })
      .catch((error) => console.error(error));
    return () => {
      disposed = true;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    eventStateRef.current = eventState;
  }, [eventState]);

  useEffect(() => {
    sessionsRef.current = visibleSessions;
  }, [visibleSessions]);

  const applyRemoteYjsUpdate = useCallback(async (docId: string, update: Uint8Array) => {
    const doc = yDocs.current.get(docId);
    if (doc) {
      Y.applyUpdate(doc, update, "remote");
      await persistDraftDoc(docId, doc);
      if (activeYDocId.current === docId) setDraft(getDraft(doc));
      return;
    }
    await mergeCachedDraftUpdate(docId, update);
  }, []);

  const flushYjsOutbox = useCallback(async (reason: string) => {
    if (!isAuthenticated || navigator.onLine === false || yOutboxFlushing.current) return;
    yOutboxFlushing.current = true;
    let flushed = 0;
    try {
      while (true) {
        const entries = await loadYjsOutboxUpdates(100);
        if (!entries.length) break;
        const response = await syncYjsOutboxEntries(entries);
        for (const remote of response.docs) {
          if (remote.update) await applyRemoteYjsUpdate(remote.docId, fromBase64(remote.update));
        }
        await deleteYjsOutboxUpdates(entries.map((entry) => entry.id));
        flushed += entries.length;
        if (entries.length < 100) break;
      }
      if (flushed) {
        void logClientEvent(
          "info",
          "yjs.outbox.flushed",
          null,
          { reason, updates: flushed },
          ["yjs", "sync"],
        ).catch(() => {});
      }
    } catch (error) {
      void logClientEvent(
        "warn",
        "yjs.outbox.flush_failed",
        error instanceof Error ? error.message : String(error),
        { reason, flushed, error },
        ["yjs", "sync"],
      ).catch(() => {});
      console.error(error);
    } finally {
      yOutboxFlushing.current = false;
    }
  }, [applyRemoteYjsUpdate, isAuthenticated]);

  const reconcileYjsDocs = useCallback(async (reason: string) => {
    if (!isAuthenticated || navigator.onLine === false) return;
    if (yReconcileRunning.current) {
      yReconcileQueued.current = true;
      return;
    }
    yReconcileRunning.current = true;
    try {
      do {
        yReconcileQueued.current = false;
        await flushYjsOutbox(`${reason}:pre`);
        const liveDocIds = new Set<string>();
        for (const [docId, doc] of yDocs.current) {
          const sessionDbId = sessionDbIdFromDocId(docId);
          if (!sessionDbId) continue;
          liveDocIds.add(docId);
          await syncDraftDoc(docId, sessionDbId, doc, true);
          if (activeYDocId.current === docId) setDraft(getDraft(doc));
        }
        const warmSessions = sessionsRef.current
          .slice(0, 20)
          .filter((session) => !liveDocIds.has(docIdForSession(session.id)));
        if (warmSessions.length) await syncCachedDraftDocs(warmSessions);
        const docIds = [...new Set([...liveDocIds, ...warmSessions.map((session) => docIdForSession(session.id))])];
        if (docIds.length) subscribeYjsSocket(ySocket.current, docIds);
        if (liveDocIds.size || warmSessions.length) {
          void logClientEvent(
            "debug",
            "yjs.reconcile.complete",
            null,
            { reason, liveDocs: liveDocIds.size, warmDocs: warmSessions.length },
            ["yjs", "sync"],
          ).catch(() => {});
        }
      } while (yReconcileQueued.current);
    } catch (error) {
      void logClientEvent(
        "warn",
        "yjs.reconcile.failed",
        error instanceof Error ? error.message : String(error),
        { reason, error },
        ["yjs", "sync"],
      ).catch(() => {});
      console.error(error);
    } finally {
      yReconcileRunning.current = false;
    }
  }, [flushYjsOutbox, isAuthenticated]);

  useEffect(() => {
    if (!canShowLocalApp) return;

    if (!visibleSessions.length) {
      setActiveSession(null);
      return;
    }

    if (route.chatId) {
      const routedSession = visibleSessions.find((session) => session.id === route.chatId) ?? null;
      if (routedSession) {
        setActiveSession(routedSession);
        return;
      }

      const fallback = visibleSessions[0];
      setActiveSession(fallback);
      navigateRoute({ chatId: fallback.id, panel: route.panel }, { replace: true });
      return;
    }

    setActiveSession(visibleSessions[0]);
  }, [canShowLocalApp, navigateRoute, route.chatId, route.panel, setActiveSession, visibleSessions]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;
      const socket = openYjsSocket((docId, update) => {
        void applyRemoteYjsUpdate(docId, update).catch((error) => console.error(error));
      });
      ySocket.current = socket;

      socket.addEventListener("open", () => {
        const warmIds = sessionsRef.current.slice(0, 20).map((session) => docIdForSession(session.id));
        subscribeYjsSocket(socket, [...new Set([...yDocs.current.keys(), ...warmIds])]);
        void flushYjsOutbox("socket_open");
        void reconcileYjsDocs("socket_open");
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
  }, [applyRemoteYjsUpdate, flushYjsOutbox, isAuthenticated, reconcileYjsDocs]);

  const scheduleYjsPush = useCallback((docId: string, sessionDbId: string, doc: Y.Doc, update: Uint8Array) => {
    void enqueueYjsOutboxUpdate({ docId, sessionDbId, update: toBase64(update) })
      .then(() => {
        if (!isAuthenticated || navigator.onLine === false) return;
        sendYjsSocketUpdate(ySocket.current, docId, sessionDbId, update);
        void flushYjsOutbox("local_update");
      })
      .catch((error) => {
        console.error(error);
        if (isAuthenticated && navigator.onLine !== false) sendYjsSocketUpdate(ySocket.current, docId, sessionDbId, update);
      });
    const current = yPushTimers.current.get(docId);
    if (current) window.clearTimeout(current);
    const timer = window.setTimeout(() => {
      yPushTimers.current.delete(docId);
      if (!isAuthenticated || navigator.onLine === false) return;
      flushYjsOutbox("local_update_debounce").catch((error) => console.error(error));
      syncDraftDoc(docId, sessionDbId, doc, true).catch((error) => console.error(error));
    }, 500);
    yPushTimers.current.set(docId, timer);
  }, [flushYjsOutbox, isAuthenticated]);

  useEffect(() => {
    return () => {
      for (const timer of yPushTimers.current.values()) window.clearTimeout(timer);
      yPushTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    const flushAndReconcile = (reason: string) => {
      void flushYjsOutbox(reason);
      void reconcileYjsDocs(reason);
    };
    const onOnline = () => flushAndReconcile("online");
    const onVisible = () => {
      if (!document.hidden) flushAndReconcile("visible");
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    flushAndReconcile("authenticated");
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [flushYjsOutbox, isAuthenticated, reconcileYjsDocs]);

  useEffect(() => {
    return () => {
      for (const refresh of sessionEventRefreshes.current.values()) refresh.controller.abort();
      sessionEventRefreshes.current.clear();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setMeta("theme", theme);
  }, [theme]);

  useEffect(() => {
    const update = () => setAutoDisplayMode(detectAutoDisplayMode());
    const queries = DISPLAY_MODE_MEDIA_QUERIES.map((query) => window.matchMedia(query));
    for (const query of queries) query.addEventListener("change", update);
    update();
    return () => {
      for (const query of queries) query.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.display = resolvedDisplayMode;
  }, [resolvedDisplayMode]);

  useEffect(() => {
    let raf: number | null = null;
    let textInputFocused = isEditableElement(document.activeElement);
    const updateViewport = () => {
      raf = null;
      textInputFocused = isEditableElement(document.activeElement);
      const viewport = window.visualViewport;
      const layoutHeight = window.innerHeight;
      const layoutWidth = window.innerWidth;
      const height = viewport?.height ?? layoutHeight;
      const width = viewport?.width ?? layoutWidth;
      const offsetTop = viewport?.offsetTop ?? 0;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      const hiddenBottom = viewport ? Math.max(0, layoutHeight - height - offsetTop) : 0;
      const touchMobileFocused =
        textInputFocused && window.matchMedia("(max-width: 780px)").matches && window.matchMedia("(hover: none), (pointer: coarse)").matches;
      const keyboardOpen = hiddenBottom >= Math.max(80, layoutHeight * 0.18) || touchMobileFocused;
      const root = document.documentElement;
      if (Number.isFinite(height) && height > 0) {
        root.style.setProperty("--app-viewport-height", `${Math.round(height)}px`);
      }
      if (Number.isFinite(width) && width > 0) root.style.setProperty("--app-viewport-width", `${Math.round(width)}px`);
      root.style.setProperty("--app-viewport-offset-top", `${Math.round(offsetTop)}px`);
      root.style.setProperty("--app-viewport-offset-left", `${Math.round(offsetLeft)}px`);
      root.style.setProperty("--app-keyboard-inset", `${Math.round(hiddenBottom)}px`);
      root.dataset.keyboard = keyboardOpen ? "open" : "closed";
    };
    const scheduleViewportUpdate = () => {
      if (raf !== null) return;
      raf = window.requestAnimationFrame(updateViewport);
    };
    const updateFocusState = () => {
      scheduleViewportUpdate();
    };
    updateViewport();
    window.addEventListener("resize", scheduleViewportUpdate);
    window.addEventListener("orientationchange", scheduleViewportUpdate);
    window.addEventListener("focusin", updateFocusState);
    window.addEventListener("focusout", updateFocusState);
    window.visualViewport?.addEventListener("resize", scheduleViewportUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleViewportUpdate);
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduleViewportUpdate);
      window.removeEventListener("orientationchange", scheduleViewportUpdate);
      window.removeEventListener("focusin", updateFocusState);
      window.removeEventListener("focusout", updateFocusState);
      window.visualViewport?.removeEventListener("resize", scheduleViewportUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleViewportUpdate);
    };
  }, []);

  useEffect(() => {
    writeLocalStorageValue(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    writeInterfacePrefs(interfacePrefs);
  }, [interfacePrefs]);

  useEffect(() => {
    writeLocalStorageValue(GROUP_BY_PROJECT_STORAGE_KEY, groupByProject ? "true" : "false");
  }, [groupByProject]);

  useEffect(() => {
    const nextRetentionDays = clampRetentionDays(retentionDays);
    if (nextRetentionDays !== retentionDays) {
      setRetentionDays(nextRetentionDays);
      return;
    }
    writeRetentionDays(nextRetentionDays);
    const previous = previousRetentionDays.current;
    if (previous === nextRetentionDays) return;
    const timer = window.setTimeout(() => {
      previousRetentionDays.current = nextRetentionDays;
      if (backfillTimer.current !== null) {
        window.clearTimeout(backfillTimer.current);
        backfillTimer.current = null;
      }
      const cutoffIso = retentionCutoffIso(nextRetentionDays);
      void pruneCacheBefore(cutoffIso)
        .then(() => refreshCache())
        .then(() => refreshSettings())
        .catch((error) => console.error(error));
      if (isAuthenticated) {
        setStatusText(`Keeping ${nextRetentionDays.toLocaleString()} days`);
        void syncNow({ metadataOnly: true, reason: "retention_changed" });
        window.setTimeout(() => void syncNow({ silent: true, metadataOnly: false, eventMode: "recent", reason: "retention_changed_recent" }), 0);
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, refreshCache, refreshSettings, retentionDays, syncNow]);

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
          await flushYjsOutbox("active_doc_load");
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
  }, [activeId, canShowLocalApp, flushYjsOutbox, isAuthenticated, scheduleYjsPush]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const id = window.setInterval(() => {
      if (!document.hidden) syncNow({ silent: true, metadataOnly: true, reason: "poll_interval" });
    }, 5000);
    const onVisible = () => {
      if (document.hidden) return;
      if (pendingIngest.current) {
        pendingIngest.current = false;
        void syncNow({ silent: true, metadataOnly: false, eventMode: "forward", reason: "visible_pending_ingest" });
      }
      void syncNow({ silent: true, metadataOnly: true, reason: "visible" });
    };
    document.addEventListener("visibilitychange", onVisible);
    const onOnline = () => {
      if (pendingIngest.current) {
        pendingIngest.current = false;
        void syncNow({ silent: true, metadataOnly: false, eventMode: "forward", reason: "online_pending_ingest" });
      }
      void syncNow({ silent: true, metadataOnly: true, reason: "online" });
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
        const snapshotActive = activeRef.current;
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
            activeId: snapshotActive?.id ?? null,
            activeTouched: Boolean(snapshotActive && message.sessionIds.includes(snapshotActive.id)),
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
          void syncNow({ silent: true, metadataOnly: false, eventMode: "forward", reason: "stream_ingest" });
        }, 50);
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
  }, [isAuthenticated, syncNow]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visibleSessions.filter((session) => {
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
  }, [query, visibleSessions]);

  const items = useMemo(() => groupItems(flatten(events)), [events]);
  const yDocIdsToKeepWarm = useMemo(() => visibleSessions.slice(0, 20).map((session) => docIdForSession(session.id)), [visibleSessions]);

  const selectSession = useCallback((session: SessionInfo) => {
    setActiveSession(session);
    navigateRoute({ chatId: session.id });
    if (window.matchMedia("(max-width: 780px)").matches) setSidebarOpen(false);
  }, [navigateRoute, setActiveSession]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!visibleSessions.length) return;
    void reconcileYjsDocs("warm_sessions_changed");
  }, [isAuthenticated, reconcileYjsDocs, visibleSessions]);

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
        <BuildBadge sha={displayedBuildSha} updateReady={serviceWorker.status.updateReady} onUpdate={applyVisibleServiceWorkerUpdate} />
      </>
    );
  }

  return (
    <div className={`app-shell display-${resolvedDisplayMode} ${sidebarOpen ? "" : "sidebar-closed"}`} style={appShellStyle}>
      <BuildBadge sha={displayedBuildSha} updateReady={serviceWorker.status.updateReady} onUpdate={applyVisibleServiceWorkerUpdate} />
      <Topbar
        active={active}
        syncState={syncState}
        statusText={statusText}
        syncHealth={syncHealth}
        now={now}
        theme={theme}
        interfacePrefs={interfacePrefs}
        interfacePrefsOpen={interfacePrefsOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleInterfacePrefs={() => setInterfacePrefsOpen((open) => !open)}
        onCloseInterfacePrefs={() => setInterfacePrefsOpen(false)}
        onInterfacePrefsChange={updateInterfacePrefs}
        onResetInterfacePrefs={resetInterfacePrefs}
        onOpenAudio={() => openPanel("audio")}
        onOpenSettings={() => openPanel("settings")}
        onSync={() => syncNow({ metadataOnly: true, reason: "manual_topbar" })}
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
          sessionStatsById={sessionStatsById}
          filteredSessionCount={filteredSessions.length}
          groupByProject={groupByProject}
          onClose={() => setSidebarOpen(false)}
          onResizePointerDown={beginSidebarResize}
          onResizeKeyDown={handleSidebarResizeKey}
          onQueryChange={setQuery}
          onSelectSession={selectSession}
          onMuteDevice={muteDevice}
          onMuteProvider={muteProvider}
          onMuteSession={muteSession}
        />

        <MainChat
          active={active}
          eventsLength={events.length}
          eventWindowed={eventState.sessionId === activeId ? eventState.windowed : false}
          hasOlderEvents={eventState.sessionId === activeId ? eventState.hasOlder : false}
          hasNewerEvents={eventState.sessionId === activeId ? eventState.hasNewer : false}
          items={items}
          draft={draft}
          now={now}
          syncHealth={syncHealth}
          syncState={syncState}
          onDraftChange={handleDraftChange}
          onLoadOlderEvents={loadOlderEventWindow}
          onLoadNewerEvents={loadNewerEventWindow}
        />
      </div>
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          cacheStats={cacheStats}
          mutedSources={mutedSources}
          mutedSummary={mutedSummary}
          loading={settingsBusy}
          message={settingsMessage}
          onClose={closePanel}
          onRefresh={refreshSettings}
          onCopy={copyText}
          onCreateToken={createImportToken}
          onCheckOpenRouter={checkOpenRouter}
          serviceWorker={serviceWorker.status}
          resetServiceWorkerUrl={offlineShellResetUrl}
          onCheckServiceWorkerUpdate={checkServiceWorkerUpdate}
          onApplyServiceWorkerUpdate={applyServiceWorkerUpdate}
          onResetOfflineShell={resetOfflineShell}
          onCopyResetServiceWorkerUrl={copyResetServiceWorkerLink}
          onRequestPersistentStorage={requestPersistentStorage}
          onResetIndexedDb={resetIndexedDb}
          onClearCaches={clearCaches}
          onRestoreMutedSource={restoreMuted}
          groupByProject={groupByProject}
          sidebarWidth={sidebarWidth}
          retentionDays={retentionDays}
          onGroupByProjectChange={setGroupByProject}
          onResetSidebarWidth={resetSidebarWidth}
          onRetentionDaysChange={setRetentionDays}
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

function BuildBadge({ sha, updateReady, onUpdate }: { sha: string | null; updateReady?: boolean; onUpdate?: () => void }) {
  const shortSha = formatBuildSha(sha);
  if (!shortSha && !updateReady) return null;
  return (
    <div className="build-badge" aria-label={shortSha ? `Build ${shortSha}` : "Build status"}>
      {shortSha && <span className="build-badge-code">{shortSha}</span>}
      {updateReady && onUpdate && (
        <button type="button" className="build-update-button" onClick={onUpdate}>
          обновить
        </button>
      )}
    </div>
  );
}

function mutedSessionMatcher(exclusions: SyncExclusionInfo[]) {
  const deviceIds = new Set(exclusions.filter((exclusion) => exclusion.kind === "device").map((exclusion) => exclusion.targetId));
  const providerKeys = new Set(exclusions.filter((exclusion) => exclusion.kind === "provider").map((exclusion) => exclusion.targetId));
  const sessionIds = new Set(exclusions.filter((exclusion) => exclusion.kind === "session").map((exclusion) => exclusion.targetId));
  return (session: SessionInfo) =>
    deviceIds.has(session.agentId) ||
    providerKeys.has(`${session.agentId}:${providerFilterValue(session)}`) ||
    sessionIds.has(session.id);
}

function buildMutedSummary(exclusions: SyncExclusionInfo[]) {
  const summary: Record<SyncExclusionKind, number> & { approxBytes: number; eventCount: number; sessionCount: number } = {
    device: 0,
    provider: 0,
    session: 0,
    approxBytes: 0,
    eventCount: 0,
    sessionCount: 0,
  };
  for (const exclusion of exclusions) {
    summary[exclusion.kind] += 1;
    summary.approxBytes += numberMetadata(exclusion.metadata.approxBytes);
    summary.eventCount += numberMetadata(exclusion.metadata.eventCount);
    summary.sessionCount += numberMetadata(exclusion.metadata.sessionCount);
  }
  return summary;
}

function mutedMetadataForSessions(sessions: SessionInfo[], statsById: Map<string, SessionCacheStat>): Record<string, unknown> {
  const providers = new Set<string>();
  const projects = new Set<string>();
  let approxBytes = 0;
  let eventCount = 0;
  for (const session of sessions) {
    const stat = statsById.get(session.id);
    providers.add(providerFilterValue(session));
    if (session.projectKey) projects.add(session.projectKey);
    approxBytes += stat?.approxBytes ?? session.sizeBytes ?? 0;
    eventCount += stat?.eventCount ?? session.eventCount;
  }
  return {
    sessionCount: sessions.length,
    eventCount,
    approxBytes,
    providers: [...providers].sort(),
    projects: [...projects].sort().slice(0, 20),
  };
}

function numberMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatBuildSha(sha: string | null) {
  const clean = sha?.trim();
  if (!clean || clean === "unknown") return null;
  return clean.slice(0, 4);
}

function isEditableElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type);
  }
  return element.isContentEditable;
}

function estimateChatHeightScale(current: InterfacePrefs, next: InterfacePrefs) {
  const currentText = Math.max(0.1, current.uiScale * current.chatScale);
  const nextText = Math.max(0.1, next.uiScale * next.chatScale);
  const textRatio = nextText / currentText;
  const densityRatio = Math.max(0.1, next.density) / Math.max(0.1, current.density);
  const widthRatio = Math.max(0.1, current.chatWidth) / Math.max(0.1, next.chatWidth);
  return Math.min(1.8, Math.max(0.5, textRatio * 0.68 + densityRatio * 0.14 + widthRatio * 0.18));
}

function mergeSyncOptions(current: SyncNowOptions | null, next: SyncNowOptions): SyncNowOptions {
  return {
    silent: current ? current.silent === true && next.silent === true : next.silent === true,
    metadataOnly: current?.metadataOnly === false || next.metadataOnly === false ? false : true,
    eventMode: mergeSyncEventMode(current?.eventMode, next.eventMode),
    reason: mergeSyncReason(current?.reason, next.reason),
  };
}

function mergeSyncReason(current?: string, next?: string) {
  if (!current) return next;
  if (!next || next === current) return current;
  return `${current}+${next}`.slice(0, 200);
}

function mergeSyncEventMode(current?: SyncNowOptions["eventMode"], next?: SyncNowOptions["eventMode"]): SyncNowOptions["eventMode"] {
  if (current === "recent" || next === "recent") return "recent";
  if (current === "forward" || next === "forward") return "forward";
  return current ?? next;
}

function retentionCutoffIso(days: number) {
  return new Date(Date.now() - clampRetentionDays(days) * 24 * 60 * 60 * 1000).toISOString();
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
      a[i].ingestedAt !== b[i].ingestedAt
    ) {
      return false;
    }
  }
  return true;
}

function mergeEventWindow(current: EventState, incoming: SessionEvent[], mode: "prepend" | "append", hasMoreInDirection: boolean): EventState {
  const events = mergeSessionEvents(mode === "prepend" ? [...incoming, ...current.events] : [...current.events, ...incoming]);
  let trimmed = events;
  let trimmedOlder = false;
  let trimmedNewer = false;
  if (events.length > CHAT_EVENT_WINDOW_MAX) {
    if (mode === "prepend") {
      trimmed = events.slice(0, CHAT_EVENT_WINDOW_MAX);
      trimmedNewer = true;
    } else {
      trimmed = events.slice(events.length - CHAT_EVENT_WINDOW_MAX);
      trimmedOlder = true;
    }
  }
  return {
    sessionId: current.sessionId,
    events: trimmed,
    windowed: true,
    hasOlder: mode === "prepend" ? hasMoreInDirection : Boolean(current.hasOlder || trimmedOlder),
    hasNewer: mode === "append" ? hasMoreInDirection : Boolean(current.hasNewer || trimmedNewer),
  };
}

function mergeSessionEvents(events: SessionEvent[]) {
  const byId = new Map<string, SessionEvent>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()].sort(compareSessionEventOrder);
}

function compareSessionEventOrder(a: SessionEvent, b: SessionEvent) {
  return a.lineNo - b.lineNo || a.offset - b.offset || a.id.localeCompare(b.id);
}

function sessionDbIdFromDocId(docId: string) {
  return docId.startsWith("chat:") ? docId.slice("chat:".length) : null;
}

function eventSourceReadyStateLabel(value: number) {
  if (value === 0) return "connecting";
  if (value === 1) return "open";
  if (value === 2) return "closed";
  return "unknown";
}

async function writeClipboardText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to the legacy path while the click activation is still live.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Could not copy");
  } finally {
    textarea.remove();
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function shouldRefreshHealthTimestamp(value: string | null, now: number) {
  const parsed = value ? Date.parse(value) : NaN;
  return !Number.isFinite(parsed) || now - parsed >= HEALTH_REFRESH_MS;
}
