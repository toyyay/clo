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

// ---------- Predicate / ViewSpec -------------------------------------------

export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { host: string }
  | { project: string }
  | { provider: "claude" | "codex" | "gemini" | "unknown" }
  | { sessionId: string }
  | { lastSeenWithin: { days: number } }
  /** Match every chat. Use as a top-level predicate when the user wants
   *  the full unscoped sidebar (no time / scope cutoff). */
  | { everything: true };

export type ViewSpec = {
  id: string;
  predicate: Predicate;
  /** explicit chat ids that must be inside the view (override predicate negative) */
  includes?: string[];
  /** explicit chat ids that must NOT be inside the view */
  excludes?: string[];
  /** if true, new chats matching predicate are auto-added */
  followNew?: boolean;
  history?: {
    /** how many tail RenderItems to deliver per chat on snapshot */
    tailItems?: number;
    /** include raw event payloads (default: false) */
    rawIncluded?: boolean;
  };
  /** receive live updates */
  liveTail?: boolean;
  /** 0..100, larger = drained first */
  priority?: number;
  /** server-suggested eviction caps */
  evict?: {
    maxChatsInMemory?: number;
    maxItemsPerChat?: number;
  };
};

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

export type ClientFrame =
  | { op: "hello"; v: number; clientId: string; deviceMemoryGb?: number; views: ClientViewState[] }
  | { op: "view.upsert"; view: ViewSpec }
  | { op: "view.delete"; viewId: string }
  | { op: "view.ack"; viewId: string; cursor: number }
  | { op: "view.focus"; viewId: string; chatId: string }
  | { op: "chat.exclude"; viewId: string; chatId: string }
  | { op: "chat.include"; viewId: string; chatId: string }
  | { op: "history.range"; reqId: string; chatId: string; before?: number; after?: number; limit: number }
  | { op: "chats.byGroup"; reqId: string; groupKey: string; afterLastSeenAt?: string; limit: number }
  | { op: "chats.search"; reqId: string; query: string; limit: number }
  | { op: "ping" };

export type ClientViewState = {
  viewId: string;
  /** sha256 of canonical(spec); if mismatched server resends snapshot */
  specHash: string;
  /** last acked cursor */
  cursor: number;
};

export type ServerFrame =
  | { op: "hello.ok"; v: number; serverTime: string }
  | { op: "view.snapshot"; viewId: string; cursor: number; groups: GroupNode[]; chats: ChatIndex[]; tails: Record<string, SeqRenderItem[]>; totals: { items: number; bytesRemaining: number } }
  | { op: "view.batch"; viewId: string; cursor: number; items: BatchItem[]; bytesRemaining: number; moreReady: boolean }
  | { op: "view.idle"; viewId: string; cursor: number }
  | { op: "view.error"; viewId: string; reason: string }
  | { op: "chat.added"; viewId: string; chat: ChatIndex; tail: SeqRenderItem[] }
  | { op: "chat.removed"; viewId: string; chatId: string; reason: "excluded" | "predicate_no_match" | "deleted"; evictHint?: boolean }
  | { op: "group.delta"; deltas: Array<Partial<GroupNode> & { key: string }> }
  | { op: "evict.suggest"; chatIds: string[]; reason: "stale" | "exceeds_quota" }
  | { op: "history.range.ok"; reqId: string; chatId: string; items: SeqRenderItem[]; hasOlder: boolean; hasNewer: boolean }
  | { op: "chats.byGroup.ok"; reqId: string; groupKey: string; chats: ChatIndex[]; hasMore: boolean }
  | { op: "chats.search.ok"; reqId: string; query: string; chats: ChatIndex[]; hasMore: boolean }
  | { op: "flow.adjust"; batchBytes: number; reason: string }
  | { op: "pong" };

export type BatchItem = {
  chatId: string;
  item: RenderItem;
  /** monotonic per-(chat) sequence — для пагинации в IDB по [chatId, seq] */
  seq: number;
};

// ---------- Predicate canonicalization (для specHash) ----------------------

/**
 * Стабильное JSON-представление спека. Ключи отсортированы.
 * Используется для вычисления specHash: server и client должны хешировать одинаково.
 */
export function canonicalizeSpec(spec: ViewSpec): string {
  return JSON.stringify(spec, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

// ---------- Predicate evaluation (для тестов / клиентских проверок) --------

/** Применяет predicate к чату. Используется в тестах и client-side фильтрах. */
export function evalPredicate(
  pred: Predicate,
  chat: { hostId: string; provider: string; projectKey: string; sessionId: string; lastSeenAt: string },
  now = Date.now(),
): boolean {
  if ("all" in pred) return pred.all.every((p) => evalPredicate(p, chat, now));
  if ("any" in pred) return pred.any.some((p) => evalPredicate(p, chat, now));
  if ("not" in pred) return !evalPredicate(pred.not, chat, now);
  if ("host" in pred) return chat.hostId === pred.host;
  if ("project" in pred) return chat.projectKey === pred.project;
  if ("provider" in pred) return chat.provider === pred.provider;
  if ("sessionId" in pred) return chat.sessionId === pred.sessionId;
  if ("lastSeenWithin" in pred) {
    const t = Date.parse(chat.lastSeenAt);
    if (!Number.isFinite(t)) return false;
    const cutoff = now - pred.lastSeenWithin.days * 86_400_000;
    return t >= cutoff;
  }
  return false;
}
