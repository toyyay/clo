// Frontend v3 entry — тонкий App, всё состояние живёт в store.
import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { ChatView } from "./chat-view";
import { Topbar } from "./topbar";
import { useStore } from "./store-hook";
import { applyVisualSettings, readInterfacePrefs, readTheme } from "./settings";

// Apply persisted visual settings synchronously, before React first paints,
// so the page never flashes the wrong theme.
applyVisualSettings(readTheme(), readInterfacePrefs());

const SIDEBAR_OPEN_KEY = "chatview-v3:sidebar-open";

export function App() {
  const store = useStore();
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
    void registerServiceWorker();
    // Expose the query escape hatch on window so we can iterate from the
    // DevTools console without rebuilding: `await chatview.q("select count(*)
    // from agent_source_files")` returns rows + durationMs + truncated flag.
    (window as unknown as { chatview?: unknown }).chatview = {
      q: (sql: string, params?: unknown[]) => store.runQuery(sql, params),
      store,
    };
    return () => store.stop();
  }, [store]);

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

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    // The legacy /service-worker.js is now a kill-switch — it self-unregisters
    // on activate. After it does, our /sw-v3.js takes over scope "/".
    await navigator.serviceWorker.register("/sw-v3.js", { scope: "/" });
  } catch (err) {
    console.warn("[sync-v3] service worker register failed", err);
  }
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
