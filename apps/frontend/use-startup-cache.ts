import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { HostInfo, SessionInfo } from "../../packages/shared/types";
import { cacheShell } from "./db";
import type { AuthState, SyncHealth, SyncNowOptions, SyncState } from "./app-types";
import { sameEntityList, withTimeout } from "./app-utils";
import { logClientEvent } from "./client-logs";
import { fetchSessionMetadata } from "./sync";

type CachedShell = {
  hosts: HostInfo[];
  sessions: SessionInfo[];
};

type StartupCacheOptions = {
  authState: AuthState;
  canShowLocalApp: boolean;
  isAuthenticated: boolean;
  checkAuth: () => Promise<void>;
  refreshCache: (options?: { apply?: boolean }) => Promise<CachedShell>;
  setAuthState: Dispatch<SetStateAction<AuthState>>;
  setHosts: Dispatch<SetStateAction<HostInfo[]>>;
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  setSyncHealth: Dispatch<SetStateAction<SyncHealth>>;
  setSyncState: Dispatch<SetStateAction<SyncState>>;
  setStatusText: Dispatch<SetStateAction<string>>;
  syncNow: (options?: SyncNowOptions) => Promise<void>;
};

const LOCAL_CACHE_STARTUP_TIMEOUT_MS = 2500;
const STARTUP_STUCK_WARNING_MS = 10000;

export function useStartupCache({
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
}: StartupCacheOptions) {
  useEffect(() => {
    const onOnline = () => {
      setSyncHealth((current) => ({ ...current, online: navigator.onLine }));
      if (authState === "cache" || authState === "checking") void checkAuth();
    };
    const onOffline = () => {
      setSyncHealth((current) => ({ ...current, online: false, lastError: "Browser is offline" }));
      if (canShowLocalApp) {
        setSyncState("offline");
        setStatusText("Offline cache");
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [authState, canShowLocalApp, checkAuth, setSyncHealth, setSyncState, setStatusText]);

  useEffect(() => {
    if (!canShowLocalApp) return;
    let disposed = false;
    const started = performance.now();
    setSyncState("loading");
    setStatusText("Loading local cache");
    const stuckTimer = window.setTimeout(() => {
      if (disposed) return;
      setSyncState("loading");
      setStatusText("Still loading chat list");
      void logClientEvent(
        "warn",
        "cache.initial_hydrate.stuck",
        "initial chat list hydrate did not finish",
        { durationMs: Math.round(performance.now() - started) },
        ["cache", "startup"],
      ).catch(() => {});
    }, STARTUP_STUCK_WARNING_MS);

    withTimeout(refreshCache({ apply: false }), LOCAL_CACHE_STARTUP_TIMEOUT_MS, "local cache hydrate timed out")
      .catch(async (error) => {
        if (disposed) throw error;
        if (!isAuthenticated || navigator.onLine === false) {
          if (error instanceof Error && error.message.includes("timed out")) return { hosts: [], sessions: [] } satisfies CachedShell;
          throw error;
        }
        setStatusText("Loading latest chat list");
        void logClientEvent(
          "warn",
          "cache.initial_hydrate.fallback",
          error instanceof Error ? error.message : String(error),
          { durationMs: Math.round(performance.now() - started), fallback: "read-api-metadata" },
          ["cache", "startup"],
        ).catch(() => {});
        const shell = await withTimeout(fetchSessionMetadata(), 10000, "server chat list read timed out");
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
        if (shell.sessions.length) setAuthState((current) => (current === "checking" ? "cache" : current));
        setSyncState(navigator.onLine ? "idle" : "offline");
        setStatusText(
          navigator.onLine
            ? shell.sessions.length
              ? `Loaded ${shell.sessions.length.toLocaleString()} cached chats`
              : "No cached chats yet"
            : "Offline cache",
        );
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
        if (isAuthenticated && !("source" in shell)) {
          void syncNow({ silent: true, metadataOnly: true });
          void syncNow({ silent: true, metadataOnly: false, eventMode: "recent" });
        }
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
  }, [
    canShowLocalApp,
    isAuthenticated,
    refreshCache,
    setAuthState,
    setHosts,
    setSessions,
    setSyncState,
    setStatusText,
    syncNow,
  ]);
}
