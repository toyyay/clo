# sync-v3 — новая архитектура синхронизации

Параллельный стек для sync, рендера, IndexedDB и WS-протокола. Существует
рядом с действующим `/api/sync` + `apps/frontend/`. Старый код не тронут.

```
master
├─ apps/frontend/          (старое — без изменений)
├─ apps/frontend-v3/       (новое — этот документ)
├─ apps/backend/sync-v3/   (новое — render pipeline + WS server)
├─ packages/sync-v3/       (новое — общий контракт)
└─ apps/backend/migrations.ts: новые миграции 0013/0014/0015 (additive)
```

Серверные эндпоинты:
- `/api/v3/ws` — WebSocket с подписками
- `/v3`, `/v3/` — раздача нового бандла
- `/`, `/api/v2/*`, `/api/sync` — без изменений

## Зачем это всё

Текущий клиент сам парсит `SessionEvent[]` через `apps/frontend/chat-transcript/transform.ts`,
держит `getAll(sessions)` в памяти, ловит rerender storm при волне ингеста и
тащит `react-markdown` (45 КБ) на парсинг каждой строки. На медленных
устройствах ощутимо больно (см. ревью `docs/` или историю коммитов).

sync-v3 переносит **всю работу на сервер**:
- Рендер итемов один раз при ingest → таблица `agent_render_items`
- Подписки — first-class объект на сервере (`client_views`)
- WebSocket вместо polling, с ack-based курсорами
- Клиент держит только окно текущего чата + лёгкий sidebar tree

## Целевые числа (на текущих 263 чатах / 599k events / 5475 МБ БД)

- **Размер event'а на проводе**: 5.5 КБ → ~1.2 КБ (×4.5 меньше)
- **Sidebar startup**: `getAll(469)` → 1-2 host-узла (×100 меньше)
- **Memory у клиента**: ~3 МБ heap → ~600 КБ (только окно чата)
- **Render storm at sync wave**: 700 events × O(N) layout → 1× layout с серверными items

## Терминология

| Термин | Что это |
|---|---|
| **ViewSpec** | Подписка: `{predicate, includes, excludes, history, followNew}` |
| **Predicate** | Boolean-tree над `host`/`provider`/`project`/`sessionId`/`lastSeenWithin` |
| **RenderItem** | Готовый к рендеру элемент: `t`/`th`/`tu`/`tr` + payload |
| **GroupNode** | Узел дерева хост→провайдер→проект для sidebar |
| **ChatIndex** | Лёгкая мета чата для sidebar (без full SessionInfo) |
| **WS Frame** | Discriminated union по `op` — см. `packages/sync-v3/contracts.ts` |

## Запустить локально

```bash
# 1. Миграции (если AUTO_MIGRATION=true ничего не нужно, иначе:)
DATABASE_URL=... AUTO_MIGRATION=true bun run apps/backend/server.ts

# 2. Бэкфилл render_items из существующих normalized events (one-time)
DATABASE_URL=... bun run v3:backfill

# 3. Бэкенд
bun run dev

# 4. Сборка фронта v3
bun run build:frontend-v3

# 5. Открыть http://localhost:3737/v3
```

## Миграции (additive, обратимые)

| Id | Добавляет |
|----|-----------|
| 0013 | `agent_render_items` + 3 индекса (chat-paged, global, agent/provider/project) |
| 0014 | `client_views`, `client_view_cursors`, `client_view_chats` |
| 0015 | materialized view `v3_group_aggregates` (host → provider → project) |

`session_events` (legacy v3, заморожена) **не дропается** — ждёт окончания
переходного периода (после полной выкатки нового клиента).

## Серверный поток данных

```
┌─ agent → /api/agent/v1/append ─┐
│ INSERT agent_normalized_events │
│        + writeRenderItemsForEvent (idempotent ON CONFLICT)
│        → INSERT agent_render_items                          │
│ COMMIT                                                       │
│ notifyV3NewEvents() → all open WS sockets dirty             │
└──────────────────────────────────────────────────────────────┘
                                ↓
┌─ WS dispatcher (per socket, single-flight per view) ────────┐
│ for each view in socket.views:                              │
│   delta = repo.fetchDelta(view, since=cursor)               │
│   send view.batch                                           │
│   ack ← client                                              │
│   cursor advance + persist client_view_cursors              │
└──────────────────────────────────────────────────────────────┘
```

## Контракт WebSocket

См. `packages/sync-v3/contracts.ts` `ClientFrame` / `ServerFrame`. Все фреймы
NDJSON (один JSON в одном WS message), discriminated по полю `op`.

Клиент → Сервер:
- `hello` — с `views[]` и cursors per view
- `view.upsert` / `view.delete` — управление подписками
- `view.ack` — подтверждение батча, продвигает cursor на сервере
- `view.focus` — boost приоритета (для активного чата)
- `chat.exclude` / `chat.include` — runtime включение/выключение чата
- `history.range` — пагинация старых items по chatId
- `ping`

Сервер → Клиент:
- `hello.ok`
- `view.snapshot` — initial materialization подписки
- `view.batch` — инкрементальная дельта
- `view.idle` — все доставлено
- `chat.added` / `chat.removed` — динамика членства
- `evict.suggest` — подсказка освободить IDB
- `history.range.ok` — ответ на `history.range` (с reqId)
- `view.error`, `pong`

## Frontend архитектура

```
apps/frontend-v3/
├─ index.html
├─ index.tsx          mount React в #root
├─ app.tsx            тонкий App, ~80 строк, state = ноль
├─ idb.ts             типизированная обёртка над IDB v5
├─ ws-client.ts       reconnecting WS, ack-replay, outbox
├─ views-store.ts     reactive store, applies ServerFrames
├─ store-hook.ts      useSyncExternalStore singleton bindings
├─ sidebar.tsx        lazy paged tree (host>provider>project)
├─ chat-view.tsx      virtual scroll + sliding window + persistent heights
├─ render.tsx         switch по RenderItem.k (без react-markdown)
└─ styles.css         минимально функциональный
```

### IDB-схема v5

| Стор | Ключ | Что хранит |
|---|---|---|
| `views` | viewId | ViewSpec + cursor + specHash |
| `view_chats` | [viewId, chatId] | мембершип чата в подписке + pinned |
| `chat_index` | chatId | ChatIndex (лёгкий, для sidebar) |
| `render_items` | [chatId, seq] | RenderItem + bytes |
| `heights` | [chatId, itemKey] | измеренная высота строки |
| `groups` | groupKey | GroupNode |
| `mutation_outbox` | id | client frames для отправки на reconnect |

Главный инвариант: **никогда не делается `getAll` на больших сторах**.
Только index cursor + range + limit.

### Скользящее окно чата

Открытие чата читает последние 200 items из IDB cursor `[chatId, seq DESC]`
+ persistent `heights` → первый кадр виртуального скролла уже с
правильными оффсетами, без remeasure storm.

При подходе к верху → `store.loadOlder()` тянет ещё 100 из IDB. Если в IDB
нет (или меньше лимита) → дотягивает с сервера через `history.range` и
складывает обратно в IDB.

### Reconnect

При reconnect клиент шлёт `hello` с `(viewId, specHash, cursor)` для каждой
подписки. Сервер сравнивает `specHash`:
- match + свежий cursor → стрим только дельты от cursor
- match + древний cursor → mini-snapshot
- mismatch → full snapshot (юзер менял spec оффлайн)

Outbox с offline-мутациями (`view.upsert`, `chat.exclude`) пушится **до**
hello, чтобы сервер применил их и пересчитал spec.

## Тестирование

```bash
bun test
# 152 pass, 0 fail
```

- `packages/sync-v3/contracts.test.ts` — canonicalizeSpec, evalPredicate
- `apps/backend/sync-v3/render.test.ts` — RenderRow генерация (10 кейсов)
- `apps/backend/sync-v3/view-resolver.test.ts` — predicate → SQL (17 кейсов)
- `apps/backend/sync-v3/ws-server.test.ts` — WS лайфцикл с fake repo (8 кейсов)

Для интеграции с реальным Postgres — отдельный smoke-сценарий
(см. `scripts/backfill-render-items.ts --dry-run`).

## Дальше делать

- [ ] Server-side markdown pre-parse → `RenderItem.blocks` (сейчас plain text)
- [ ] Group aggregates push через `group.delta` (сейчас polling refresh)
- [ ] Yjs мост через тот же `/api/v3/ws` (драфты пока на старом yjs WS)
- [ ] Service Worker для офлайн-фолбэка `/v3`
- [ ] Eviction worker по `navigator.storage.estimate()`
- [ ] React Compiler + tree-shake чтобы добить бандл с 420 KB до < 200 KB
- [ ] Поиск (FTS) поверх `agent_render_items.payload->>'txt'`
- [ ] Удаление старого клиента + `/api/sync` + `session_events` после стабильной выкатки

## Откат

Каждая фаза обратима независимо. Самый агрессивный откат:

```bash
# 1. Не используем v3 — клиенты остаются на /
# 2. (опционально) drop новых таблиц
psql -c "drop materialized view if exists v3_group_aggregates"
psql -c "drop table if exists client_view_chats"
psql -c "drop table if exists client_view_cursors"
psql -c "drop table if exists client_views"
psql -c "drop table if exists agent_render_items"
psql -c "delete from schema_migrations where id in ('0013','0014','0015')"
# 3. git revert <commits>
```

Старые таблицы и старый код во всех случаях не тронуты.
