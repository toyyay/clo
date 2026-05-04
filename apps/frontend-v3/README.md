# frontend-v3

Frontend на новом стеке `sync-v3`. Параллельный с `apps/frontend/`.

См. полную архитектуру в `docs/sync-v3.md`.

## Запустить

```bash
# Бэкенд
bun run dev

# Сборка
bun run build:frontend-v3

# Открыть
open http://localhost:3737/v3
```

В deploy mode `apps/backend/server.ts` импортирует `apps/frontend-v3/index.html`
и Bun сам бандлит JS+CSS на лету. Билд через `bun build` нужен только для
production-минификации в `dist/frontend-v3/`.

## Структура

| Файл | Роль | Заменяет в старом клиенте |
|---|---|---|
| `idb.ts` | IndexedDB schema v5 + типизированный API | `apps/frontend/db.ts` |
| `ws-client.ts` | Reconnecting WebSocket | poll-loop в `apps/frontend/sync.ts` |
| `views-store.ts` | Reactive store, применяет ServerFrames | разрозненный state в `App.tsx` |
| `store-hook.ts` | `useSyncExternalStore` bindings | — |
| `app.tsx` | Тонкий App | `apps/frontend/App.tsx` (2479 строк → 80) |
| `sidebar.tsx` | Lazy paged tree | `apps/frontend/session-sidebar.tsx` |
| `chat-view.tsx` | Virtual scroll + sliding window | `apps/frontend/chat-transcript/virtual-chat.tsx` |
| `render.tsx` | Switch по `RenderItem.k` | `apps/frontend/markdown.tsx` + `chat-transcript/render-item.tsx` |
| `styles.css` | Минимальный функциональный CSS | — |

## Ключевые принципы

1. **`getAll` запрещён на `chat_index`/`render_items`** — только index cursor с лимитом.
2. **Никаких frontend-side трансформаций events** — сервер шлёт готовый `RenderItem`.
3. **Sliding window** — в памяти максимум ~400 items вокруг видимой области.
4. **Persistent heights** — `[chatId, itemKey]` → измеренная высота, hydrate при открытии чата.
5. **Один контейнерный ResizeObserver**, throttled flush 30 ms.
6. **Reactive подписка** через `useSyncExternalStore` — обновляется только видимый узел.

## Что НЕ работает в офлайне

| Действие | Статус |
|---|---|
| Просмотр закешированных RenderItems | ✅ |
| Скролл older в пределах `tailItems` подписки | ✅ |
| Скролл older за пределами кеша | ❌ — баннер "подключитесь к интернету" |
| Открытие чата без событий в IDB | ❌ — только мета |
| Изменение подписки оффлайн | ✅ → mutation_outbox |
| Получение новых сообщений | ❌ очевидно |

## Тестирование руками

1. `bun run dev` — запустить бэк
2. Накатить миграции (или `AUTO_MIGRATION=true`)
3. `bun run v3:backfill` — заполнить `agent_render_items` из существующих normalized
4. `bun run build:frontend-v3`
5. `open http://localhost:3737/v3`
6. Должен открыться sidebar с host-узлами; раскрытие должно работать; клик
   по чату → открывается окно.
7. DevTools → Application → IndexedDB → `chatview-v3` — посмотреть что
   аккумулировалось.

## TODO до production

См. секцию "Дальше делать" в `docs/sync-v3.md`.
