import { useEffect } from "react";
import type { SessionEvent, SessionInfo } from "../../packages/shared/types";
import type { AuthState, EventState, SyncNowOptions } from "./app-types";
import { loadSessionEvents } from "./db";
import { logClientEvent } from "./client-logs";
import { withTimeout } from "./app-utils";

type RefLike<T> = {
  current: T;
};

type SessionEventsCacheOptions = {
  activeId: string | null;
  expectedEventCount?: number;
  authState: AuthState;
  canShowLocalApp: boolean;
  isAuthenticated: boolean;
  activeRef: RefLike<SessionInfo | null>;
  eventStateRef: RefLike<EventState>;
  ensureSessionEventsTarget: (sessionId: string) => void;
  onNoActiveSession: () => void;
  setSessionEvents: (sessionId: string | null, nextEvents: SessionEvent[]) => void;
  syncNow: (options?: SyncNowOptions) => Promise<void>;
  refreshActiveSessionEvents: (
    sessionId: string,
    reason: string,
    cachedEvents: number,
    expectedEvents: number,
  ) => Promise<boolean>;
  markServerError: (error: unknown) => void;
};

const SESSION_EVENTS_CACHE_TIMEOUT_MS = 2500;

export function useSessionEventsCache({
  activeId,
  expectedEventCount,
  authState,
  canShowLocalApp,
  isAuthenticated,
  activeRef,
  eventStateRef,
  ensureSessionEventsTarget,
  onNoActiveSession,
  setSessionEvents,
  syncNow,
  refreshActiveSessionEvents,
  markServerError,
}: SessionEventsCacheOptions) {
  useEffect(() => {
    if (!canShowLocalApp) return;
    if (!activeId) {
      onNoActiveSession();
      return;
    }

    const loadForSessionId = activeId;
    let disposed = false;
    ensureSessionEventsTarget(loadForSessionId);

    withTimeout(
      loadSessionEvents(loadForSessionId),
      SESSION_EVENTS_CACHE_TIMEOUT_MS,
      "local session events read timed out",
    )
      .catch((error) => {
        void logClientEvent(
          "error",
          "cache.session_events.failed",
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
        if (!isAuthenticated || navigator.onLine === false) {
          void logClientEvent(
            "info",
            "read.session_events.local_cache",
            null,
            { sessionId: loadForSessionId, cachedEvents: cachedEvents.length, expectedEvents, online: navigator.onLine, authState },
            ["read", "cache", "session"],
          ).catch(() => {});
          return;
        }
        if (cachedEvents.length && cachedEvents.length < expectedEvents) {
          void syncNow({ silent: true, metadataOnly: false, eventMode: "forward" });
          try {
            await refreshActiveSessionEvents(loadForSessionId, "cache_behind_metadata", cachedEvents.length, expectedEvents);
          } catch (error) {
            markServerError(error);
            void logClientEvent(
              "warn",
              "read.session_events.cache_behind_refresh_failed",
              error instanceof Error ? error.message : String(error),
              { sessionId: loadForSessionId, cachedEvents: cachedEvents.length, expectedEvents, error },
              ["read", "session", "sync"],
            ).catch(() => {});
          }
          return;
        }

        await refreshActiveSessionEvents(loadForSessionId, "open_session", cachedEvents.length, expectedEvents);
      })
      .catch((error) => {
        markServerError(error);
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
  }, [
    activeId,
    authState,
    canShowLocalApp,
    expectedEventCount,
    isAuthenticated,
    activeRef,
    eventStateRef,
    ensureSessionEventsTarget,
    markServerError,
    onNoActiveSession,
    refreshActiveSessionEvents,
    setSessionEvents,
    syncNow,
  ]);
}
