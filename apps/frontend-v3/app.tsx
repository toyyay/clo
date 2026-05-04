// Frontend v3 entry — тонкий App, всё состояние живёт в store.
import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { ChatView } from "./chat-view";
import { Topbar } from "./topbar";
import { useStore, useStoreState } from "./store-hook";
import { applyVisualSettings, readFontScale, readTheme } from "./settings";
import type { ViewSpec } from "../../packages/sync-v3/contracts";

// Apply persisted visual settings synchronously, before React first paints,
// so the page never flashes the wrong theme.
applyVisualSettings(readTheme(), readFontScale());

const DEFAULT_VIEW: ViewSpec = {
  id: "all-recent",
  predicate: { lastSeenWithin: { days: 30 } },
  followNew: true,
  history: { tailItems: 200 },
  liveTail: true,
  priority: 50,
};

const SIDEBAR_OPEN_KEY = "chatview-v3:sidebar-open";

export function App() {
  const store = useStore();
  const state = useStoreState();
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_OPEN_KEY);
      if (v === null) return window.matchMedia("(min-width: 780px)").matches;
      return v === "1";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const clientId = ensureClientId();
    void store.start({ url: makeWsUrl(), clientId });
    return () => store.stop();
  }, [store]);

  // First-run bootstrap: install default view if none configured yet.
  useEffect(() => {
    if (state.status.kind === "open" && state.views.size === 0) {
      void store.upsertView(DEFAULT_VIEW);
    }
  }, [state.status.kind, state.views.size, store]);

  const toggleSidebar = () => {
    setSidebarOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(SIDEBAR_OPEN_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  return (
    <div className={`app ${sidebarOpen ? "sidebar-on" : "sidebar-off"}`}>
      <Topbar onToggleSidebar={toggleSidebar} sidebarOpen={sidebarOpen} />
      <Sidebar visible={sidebarOpen} />
      <ChatView />
      <BuildBadge />
    </div>
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
  return (
    <div className="build-badge" aria-hidden="true">
      {sha}
    </div>
  );
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
