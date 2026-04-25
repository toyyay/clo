import { useCallback, useEffect, useMemo, useState } from "react";

export type RoutePanel = "audio" | "settings";

export type AppRoute = {
  chatId?: string;
  panel?: RoutePanel;
};

const routeListeners = new Set<() => void>();

export function parseRoute(hash = window.location.hash): AppRoute {
  const raw = hash.replace(/^#/, "").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean).map(decodeRoutePart);

  if (parts[0] === "chats" && parts[1]) {
    return {
      chatId: parts[1],
      panel: parsePanel(parts[2]),
    };
  }

  return {
    panel: parsePanel(parts[0]),
  };
}

export function routeHash(route: AppRoute) {
  const parts = [];
  if (route.chatId) parts.push("chats", encodeRoutePart(route.chatId));
  if (route.panel) parts.push(route.panel);
  return parts.length ? `#/${parts.join("/")}` : "#/";
}

export function navigate(route: AppRoute, options: { replace?: boolean } = {}) {
  const next = routeHash(route);
  if (window.location.hash === next) return;

  if (options.replace) {
    const url = new URL(window.location.href);
    url.hash = next;
    window.history.replaceState(null, "", url);
    notifyRouteListeners();
    return;
  }

  window.location.hash = next;
}

export function useRoute() {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion((current) => current + 1);
    routeListeners.add(listener);
    window.addEventListener("hashchange", listener);
    window.addEventListener("popstate", listener);
    return () => {
      routeListeners.delete(listener);
      window.removeEventListener("hashchange", listener);
      window.removeEventListener("popstate", listener);
    };
  }, []);

  const route = useMemo(() => parseRoute(), [version]);

  const go = useCallback((next: AppRoute, options?: { replace?: boolean }) => {
    navigate(next, options);
  }, []);

  return [route, go] as const;
}

function parsePanel(value?: string): RoutePanel | undefined {
  return value === "audio" || value === "settings" ? value : undefined;
}

function encodeRoutePart(value: string) {
  return encodeURIComponent(value);
}

function decodeRoutePart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function notifyRouteListeners() {
  for (const listener of routeListeners) listener();
}
