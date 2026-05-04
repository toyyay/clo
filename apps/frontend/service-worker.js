// KILL-SWITCH service worker.
//
// Раньше этот файл precache'ил старый shell под scope `/`. После перевода `/`
// на sync-v3 нужно избавиться от уже зарегистрированных SW в браузерах
// пользователей, иначе старый кеш будет перехватывать новый `/` и юзер не
// увидит v3 пока не очистит вручную.
//
// Жизненный цикл этого файла:
//   1. Браузер при следующей навигации к `/` (или раз в 24ч) делает GET
//      `/service-worker.js`. Получает этот скрипт.
//   2. install → skipWaiting (становится активным сразу).
//   3. activate → удалить все caches, unregister самого себя, рассказать
//      открытым вкладкам перезагрузиться. Они получают v3 без старого SW.
//   4. fetch handler НЕТ — без него SW не intercept'ит запросы, но успевает
//      выполнить activate-cleanup перед unregister.
//
// Новый v3-клиент SW не регистрирует — он живёт через WS и IDB.
//
// Когда legacy полностью удалят, можно дропнуть и этот файл; до тех пор он
// должен остаться, чтобы новые reload'ы устаревших SW и дальше деинсталили
// предыдущие версии.

const BUILD_SHA = "__CHATVIEW_BUILD_SHA__";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      } catch {}
      try {
        await self.clients.claim();
      } catch {}
      try {
        await self.registration.unregister();
      } catch {}
      try {
        const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const win of wins) {
          // Reload so the page comes back with NO controlling SW.
          win.navigate(win.url).catch(() => {});
        }
      } catch {}
    })(),
  );
});

// Respond to legacy clients that ping for version — keeps old sw-client.ts
// from logging "no SW" while it lives out its last days.
self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message?.type === "GET_VERSION") {
    event.ports?.[0]?.postMessage({
      type: "VERSION",
      version: BUILD_SHA || "kill-switch",
      installedAt: new Date().toISOString(),
    });
  }
});

// No fetch handler — every request goes straight to the network until this
// SW finishes deactivating itself.
