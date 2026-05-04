// Frontend v3 entry — тонкий App, всё состояние живёт в store.
import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { ChatView } from "./chat-view";
import { useStore, useStoreState } from "./store-hook";
import type { ViewSpec } from "../../packages/sync-v3/contracts";

const DEFAULT_VIEW: ViewSpec = {
  id: "all-recent",
  predicate: { lastSeenWithin: { days: 30 } },
  followNew: true,
  history: { tailItems: 200 },
  liveTail: true,
  priority: 50,
};

export function App() {
  const store = useStore();
  const state = useStoreState();

  useEffect(() => {
    const clientId = ensureClientId();
    void store.start({ url: makeWsUrl(), clientId });
    return () => store.stop();
  }, [store]);

  // First-run bootstrap: if no views configured, install a default one
  useEffect(() => {
    if (state.status.kind === "open" && state.views.size === 0) {
      void store.upsertView(DEFAULT_VIEW);
    }
  }, [state.status.kind, state.views.size, store]);

  return (
    <div className="app">
      <Sidebar />
      <ChatView />
      <Statusbar />
      <BuildBadge />
      <AppMenu />
    </div>
  );
}

function AppMenu() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const reload = () => location.reload();
  const resetAndReload = async () => {
    if (!confirm("Reset local cache and reload? This drops IndexedDB, view subscriptions and the local client id.")) return;
    try {
      // 1. Stop the WS so deletion isn't fighting an open transaction.
      store.stop();
      // 2. Drop our IDB schema.
      await new Promise<void>((res) => {
        const req = indexedDB.deleteDatabase("chatview-v3");
        req.onsuccess = () => res();
        req.onerror = () => res();
        req.onblocked = () => res();
      });
      // 3. Drop localStorage keys (client id + sidebar expansion).
      localStorage.removeItem("chatview-v3:client-id");
      localStorage.removeItem("chatview-v3:sidebar-expanded");
      // 4. Unregister any remaining service workers + clear all caches as a
      //    belt-and-suspenders measure (legacy SW kill-switch should already
      //    have done this, but Boox / old browsers may have lagged).
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
      }
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n).catch(() => {})));
      }
    } catch {}
    location.reload();
  };
  const forceResync = async () => {
    // Stop+start the WS — drainOutbox will re-upsert all known views,
    // server will respond with snapshot. Cheaper than full reset.
    store.stop();
    setTimeout(() => location.reload(), 100);
  };

  return (
    <>
      <button
        className="app-menu-button"
        aria-label="App menu"
        onClick={() => setOpen((v) => !v)}
        title="App menu"
      >
        ⋯
      </button>
      {open && (
        <div className="app-menu-pop" onMouseLeave={() => setOpen(false)}>
          <button onClick={reload}>Reload</button>
          <button onClick={forceResync}>Force re-sync</button>
          <button onClick={resetAndReload}>Reset & reload</button>
          <a href="/v2">Open legacy /v2</a>
        </div>
      )}
    </>
  );
}

function BuildBadge() {
  const [sha, setSha] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { commit_sha?: string }) => {
        if (cancelled) return;
        if (typeof j.commit_sha === "string" && j.commit_sha.length > 0) {
          setSha(j.commit_sha.slice(0, 7));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!sha) return null;
  // aria-hidden + pointer-events:none + user-select:none — невидим для DOM-кликов,
  // не выделяется, не реагирует на курсор. Просто буквы поверх всего.
  return (
    <div className="build-badge" aria-hidden="true">
      {sha}
    </div>
  );
}

function Statusbar() {
  const state = useStoreState();
  return (
    <footer className="statusbar">
      <span className={`status-pill status-${state.status.kind}`}>
        {statusLabel(state.status)}
      </span>
      <span className="status-views">{state.views.size} views</span>
    </footer>
  );
}

function statusLabel(status: { kind: string }): string {
  switch (status.kind) {
    case "open":
      return "online";
    case "connecting":
      return "connecting…";
    case "reconnecting":
      return "reconnecting…";
    case "closed":
      return "offline";
    default:
      return status.kind;
  }
}

function makeWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/v3/ws`;
}

function ensureClientId(): string {
  const KEY = "chatview-v3:client-id";
  try {
    const cur = localStorage.getItem(KEY);
    if (cur) return cur;
    const id = `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return `c-anon-${Date.now().toString(36)}`;
  }
}
