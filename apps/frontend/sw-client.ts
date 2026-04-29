import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SW_URL = "/service-worker.js";
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export type ServiceWorkerStatus = {
  supported: boolean;
  registered: boolean;
  controlled: boolean;
  installing: boolean;
  updateReady: boolean;
  activeVersion: string | null;
  waitingVersion: string | null;
  lastCheckAt: string | null;
  lastError: string | null;
};

export function useServiceWorkerLifecycle() {
  const [status, setStatus] = useState<ServiceWorkerStatus>(() => ({
    supported: "serviceWorker" in navigator,
    registered: false,
    controlled: Boolean(navigator.serviceWorker?.controller),
    installing: false,
    updateReady: false,
    activeVersion: null,
    waitingVersion: null,
    lastCheckAt: null,
    lastError: null,
  }));
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);
  const applyingUpdate = useRef(false);
  const lastAutoCheckAt = useRef(0);

  const refreshStatus = useCallback(async (registration?: ServiceWorkerRegistration | null, patch: Partial<ServiceWorkerStatus> = {}) => {
    const reg = registration ?? registrationRef.current;
    const waitingWorker = reg?.waiting ?? waitingWorkerRef.current;
    if (waitingWorker) waitingWorkerRef.current = waitingWorker;
    const [activeVersion, waitingVersion] = await Promise.all([
      getWorkerVersion(reg?.active ?? navigator.serviceWorker.controller),
      getWorkerVersion(waitingWorker),
    ]);
    setStatus((current) => ({
      ...current,
      supported: "serviceWorker" in navigator,
      registered: Boolean(reg) || current.registered,
      controlled: Boolean(navigator.serviceWorker.controller),
      installing: Boolean(reg?.installing),
      updateReady: Boolean(waitingWorker),
      activeVersion: activeVersion ?? current.activeVersion,
      waitingVersion: waitingVersion ?? null,
      ...patch,
    }));
  }, []);

  const checkForUpdate = useCallback(async () => {
    const registration = registrationRef.current ?? (await navigator.serviceWorker?.getRegistration?.("/"));
    if (!registration) {
      setStatus((current) => ({ ...current, lastError: "Service worker is not registered" }));
      return;
    }
    try {
      const updated = await registration.update();
      registrationRef.current = updated;
      await refreshStatus(updated, { lastCheckAt: new Date().toISOString(), lastError: null });
    } catch (error) {
      setStatus((current) => ({
        ...current,
        lastCheckAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : "Could not check for update",
      }));
    }
  }, [refreshStatus]);

  const applyUpdate = useCallback(async () => {
    const worker = waitingWorkerRef.current ?? registrationRef.current?.waiting;
    if (!worker) {
      setStatus((current) => ({ ...current, lastError: "No update is waiting" }));
      return;
    }
    applyingUpdate.current = true;
    worker.postMessage({ type: "SKIP_WAITING" });
    window.setTimeout(() => {
      if (applyingUpdate.current) window.location.reload();
    }, 6000);
  }, []);

  const resetOfflineShell = useCallback(async () => {
    await resetServiceWorkersAndCaches();
    window.location.replace(resetServiceWorkerUrl());
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register(SW_URL, {
          scope: "/",
          updateViaCache: "none",
        });
        if (disposed) return;
        registrationRef.current = registration;
        observeRegistration(registration, refreshStatus);
        await refreshStatus(registration, { registered: true, lastError: null });
      } catch (error) {
        if (!disposed) {
          setStatus((current) => ({
            ...current,
            lastError: error instanceof Error ? error.message : "Service worker registration failed",
          }));
        }
      }
    };

    if (document.readyState === "complete") {
      void register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    const onControllerChange = () => {
      setStatus((current) => ({ ...current, controlled: true }));
      if (applyingUpdate.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      disposed = true;
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!status.supported) return;
    const maybeCheck = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastAutoCheckAt.current < UPDATE_CHECK_INTERVAL_MS) return;
      lastAutoCheckAt.current = now;
      void checkForUpdate();
    };
    const id = window.setInterval(maybeCheck, UPDATE_CHECK_INTERVAL_MS);
    window.addEventListener("focus", maybeCheck);
    document.addEventListener("visibilitychange", maybeCheck);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", maybeCheck);
      document.removeEventListener("visibilitychange", maybeCheck);
    };
  }, [checkForUpdate, status.supported]);

  return useMemo(
    () => ({
      status,
      checkForUpdate,
      applyUpdate,
      resetOfflineShell,
    }),
    [applyUpdate, checkForUpdate, resetOfflineShell, status],
  );
}

export function resetServiceWorkerUrl() {
  const url = new URL(window.location.href);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("reset-sw", "1");
  return url.toString();
}

async function resetServiceWorkersAndCaches() {
  const registrations = navigator.serviceWorker?.getRegistrations ? await navigator.serviceWorker.getRegistrations().catch(() => []) : [];
  await Promise.all(
    registrations
      .filter((registration) => registration.scope.startsWith(window.location.origin))
      .map((registration) => registration.unregister()),
  );
  if ("caches" in window) {
    const names = await caches.keys().catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith("chatview-")).map((name) => caches.delete(name)));
  }
}

function observeRegistration(
  registration: ServiceWorkerRegistration,
  refreshStatus: (registration?: ServiceWorkerRegistration | null, patch?: Partial<ServiceWorkerStatus>) => Promise<void>,
) {
  if (registration.waiting) void refreshStatus(registration);
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    void refreshStatus(registration, { installing: true });
    worker?.addEventListener("statechange", () => {
      void refreshStatus(registration, { installing: worker.state !== "installed" && worker.state !== "activated" });
    });
  });
}

function getWorkerVersion(worker?: ServiceWorker | null): Promise<string | null> {
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(null), 800);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      const version = typeof event.data?.buildSha === "string" ? event.data.buildSha : null;
      resolve(version && version !== "__CHATVIEW_BUILD_SHA__" ? version : null);
    };
    try {
      worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
    } catch {
      window.clearTimeout(timer);
      resolve(null);
    }
  });
}
