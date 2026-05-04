// Frontend v3 entry — тонкий App, всё состояние живёт в store.
import { useEffect } from "react";
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
