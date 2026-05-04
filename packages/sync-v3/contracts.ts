// sync-v3 — единый контракт между сервером, клиентом и тестами.
//
// Принципы:
//   • RenderItem — то что клиент рисует. compact, без raw.
//   • ViewSpec — описание подписки, объект first-class на сервере.
//   • Все WS-фреймы — discriminated union по `op`, версионируются полем `v`.
//
// Если меняешь shape сообщения, не ломая совместимость:
//   • добавляй новые поля как опциональные
//   • добавляй новые `op` значения
//   • НЕ переименовывай существующие поля
//   • при breaking change — поднимай WS_PROTOCOL_VERSION

export const WS_PROTOCOL_VERSION = 1;

// ---------- RenderItem -----------------------------------------------------

/** Готовый к рендеру элемент чата. Заменяет SessionEvent + transform. */
export type RenderItem = TextItem | ThinkingItem | ToolUseItem | ToolResultItem | ToolGroupItem;

export type TextItem = {
  k: "t";
  /** sourceEventId */
  id: number;
  /** part index inside source event */
  p: number;
  /** roles compressed to single chars: u=user, a=assistant */
  r: "u" | "a";
  /** plain text after readable transform (server-side) */
  txt: string;
  /** optional pre-parsed markdown blocks (Phase 5+); if missing client renders txt as plaintext */
  blocks?: MarkdownBlock[];
};

export type ThinkingItem = {
  k: "th";
  id: number;
  p: number;
  txt: string;
};

export type ToolUseItem = {
  k: "tu";
  id: number;
  p: number;
  /** tool name */
  name: string;
  /** tool input — small JSON, server can pre-truncate large payloads */
  in: unknown;
  /** tool_use id used to pair with results */
  tid: string;
};

export type ToolResultItem = {
  k: "tr";
  id: number;
  p: number;
  /** stringified, possibly pre-truncated (max 4096 chars) */
  out: string;
  /** true if truncated; client shows "load full" affordance */
  trunc?: boolean;
  isErr?: boolean;
  /** matches ToolUseItem.tid */
  tid: string;
};

/** Reference-only group; uses + results live as their own items, this just tells client to wrap them. */
export type ToolGroupItem = {
  k: "tg";
  /** ids of tool_use items in render order */
  uses: Array<{ id: number; p: number }>;
  /** ids of tool_result items in render order */
  results: Array<{ id: number; p: number }>;
};

/** Item with its sync_revision-derived seq, for stable IDB ordering. */
export type SeqRenderItem = {
  item: RenderItem;
  /** monotonic seq used as IDB sort key — derived from sync_revision; stable across snapshot/batch/history */
  seq: number;
};

/** Минимальный pre-parsed markdown — чтобы клиент не тащил react-markdown. */
export type MarkdownBlock =
  | { t: "p"; s: string }
  | { t: "h"; lvl: 1 | 2 | 3 | 4 | 5 | 6; s: string }
  | { t: "code"; lang?: string; s: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "quote"; s: string }
  | { t: "hr" };

// ---------- Aggregates / Sidebar -------------------------------------------

export type GroupNode = {
  /** unique stable key like "h:macbook|p:claude|pr:food" */
  key: string;
  /** 1=host, 2=provider, 3=project */
  level: 1 | 2 | 3;
  parentKey: string | null;
  label: string;
  chatCount: number;
  approxBytes: number;
  lastSeenAt: string;
  /** 5 freshest chat ids for preview without full chat list load */
  topChatIds: string[];
};

/** Lightweight chat metadata for sidebar list (paged, by [groupKey, lastSeenAt DESC]). */
export type ChatIndex = {
  chatId: string;
  groupKey: string;
  hostId: string;
  provider: string;
  projectKey: string;
  title: string;
  lastSeenAt: string;
  approxBytes: number;
  itemCount: number;
};

// ---------- WS Frames ------------------------------------------------------
//
// v4 protocol: minimal pull-on-tick. Server is a dumb transport — it
// broadcasts {op:"tick", maxRev, files} when ingest writes new render rows
// and otherwise just relays `query.ok`/`query.err` replies to the client's
// own SELECT statements. There is NO predicate / snapshot / batch state on
// the server side; the client decides what to re-pull and applies its own
// filters via SQL WHERE clauses.
//
// `query.run` is kept as a deprecated alias of `query` so the DevTools
// escape hatch (`window.chatview.q(...)`) keeps working in both spellings.

export type ClientFrame =
  | { op: "hello"; v: number; clientId: string; deviceMemoryGb?: number }
  | { op: "query"; reqId: string; sql: string; params?: unknown[] }
  /** Deprecated alias of `query` — kept so the DevTools escape hatch keeps
   *  working without rebuilding. Both ops have identical semantics. */
  | { op: "query.run"; reqId: string; sql: string; params?: unknown[] }
  | { op: "ping" };

export type ServerFrame =
  | { op: "hello.ok"; v: number; serverTime: string; maxRev: number }
  /** Live-tick: "something changed in the DB". `files` is a short list of
   *  affected source_file_ids when the debounce window stays small enough;
   *  if it grows past ~64 ids server omits it and client re-pulls broadly. */
  | { op: "tick"; maxRev: number; files?: number[] }
  /** Reply to `query` / `query.run`. `maxRev` is the largest sync_revision
   *  visible to the read transaction at the time the rows were collected;
   *  clients use it to decide if they're already caught up to the latest
   *  tick (race-safe re-pull tracker). */
  | { op: "query.ok"; reqId: string; rows: Record<string, unknown>[]; rowCount: number; durationMs: number; truncated: boolean; maxRev: number }
  | { op: "query.err"; reqId: string; error: string }
  /** Deprecated aliases of query.ok / query.err — emitted for `query.run`
   *  callers so existing DevTools snippets keep parsing. */
  | { op: "query.run.ok"; reqId: string; rows: Record<string, unknown>[]; rowCount: number; durationMs: number; truncated: boolean; maxRev: number }
  | { op: "query.run.err"; reqId: string; error: string }
  | { op: "pong" };
