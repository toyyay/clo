import { createRoot } from "react-dom/client";
import { App } from "./App";

resetShellCachesIfRequested().then((reset) => {
  if (!reset) createRoot(document.getElementById("root")!).render(<App />);
});

async function resetShellCachesIfRequested() {
  const url = new URL(window.location.href);
  const hashRequested = /[?&](?:reset-sw|resetServiceWorkers)=1\b/.test(url.hash);
  const requested = url.searchParams.get("reset-sw") === "1" || url.searchParams.get("resetServiceWorkers") === "1" || hashRequested;
  if (!requested) return false;

  const registrations = navigator.serviceWorker?.getRegistrations ? await navigator.serviceWorker.getRegistrations().catch(() => []) : [];
  await Promise.all(registrations.filter((registration) => registration.scope.startsWith(window.location.origin)).map((registration) => registration.unregister()));
  if ("caches" in window) {
    const names = await caches.keys().catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith("chatview-")).map((name) => caches.delete(name)));
  }

  url.searchParams.delete("reset-sw");
  url.searchParams.delete("resetServiceWorkers");
  url.hash = cleanHashResetParams(url.hash);
  window.location.replace(url.toString());
  return true;
}

function cleanHashResetParams(hash: string) {
  if (!hash.includes("?")) return hash;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const question = raw.indexOf("?");
  const path = raw.slice(0, question);
  const params = new URLSearchParams(raw.slice(question + 1));
  params.delete("reset-sw");
  params.delete("resetServiceWorkers");
  const query = params.toString();
  return `#${query ? `${path}?${query}` : path}`;
}
