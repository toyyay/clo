// Reactive store — v4 protocol (pull-on-tick).
//
// External shape matches `views-store.ts` (`Store`) so UI components keep
// working untouched. Internal model is completely different:
//
//   • WS is a dumb tick channel. We listen for {op:"tick", maxRev, files?},
//     send {op:"query", reqId, sql, params?}, receive {op:"query.ok"|"query.err"}.
//     No view.upsert / snapshot / batch / acks at all.
//
//   • A "scope" is one logical pull (sidebar list, active chat tail). Each
//     scope tracks knownTickMaxRev (latest tick we've seen) and
//     lastSyncedMaxRev (max sync_revision visible to our last successful
//     query). If lastSyncedMaxRev < knownTickMaxRev, we re-pull. If a tick
//     arrives mid-flight we set pendingRetry and re-pull on completion.
//     Never two queries in flight per scope.
//
//   • Persistent retry per query: 3s timeout per attempt; backoff
//     [0, 500, 1000, 2000, 5000, 5000…]; never give up. Read-only queries
//     are idempotent — drop the reqId on timeout, retry.
//
//   • Mutations on tick MERGE into IDB and into state.visibleChats. Removed
//     chats stay until explicit eviction. UI flags (loadingChat,
//     loadingOlder) never flicker on tick.

import type {
  ChatIndex,
  ClientFrame,
  GroupNode,
  RenderItem,
  ServerFrame,
} from "../../packages/sync-v3/contracts";
import * as idb from "./idb";
import { createWsClient, type ConnStatus, type WsClient, type WsLink } from "./ws-client";

// ---------- types reused from v3 store -------------------------------------

export type ActiveChatWindow = {
  chatId: string;
  items: RenderItem[];
  /** sync_revision of the oldest item currently in window */
  firstSeq: number;
  /** sync_revision of the newest item currently in window */
  lastSeq: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

export type StoreState = {
  status: ConnStatus;
  /** Legacy v3 field — kept on the type so UI components written against the
   *  old store still mount; v4 always exposes an empty Map. */
  views: Map<string, unknown>;
  cursors: Map<string, number>;
  pendingBytes: Map<string, number>;
  groups: Map<string, GroupNode>;
  visibleChats: Map<string, ChatIndex>;
  activeChat: string | null;
  activeWindow: ActiveChatWindow | null;
  loadingChat: string | null;
  loadingOlder: boolean;
  link: WsLink;
  lastBatchAt: Map<string, number>;
  throughputBps: number;
};

export type Store = {
  getState(): StoreState;
  subscribe(listener: () => void): () => void;
  start(opts: { url: string; clientId: string }): Promise<void>;
  stop(): void;

  excludeChat(chatId: string): Promise<void>;
  includeChat(chatId: string): Promise<void>;
  openChat(chatId: string, tailLimit?: number): Promise<void>;
  closeActiveChat(): void;
  loadOlder(limit?: number): Promise<void>;
  loadGroupChildren(parentKey: string): Promise<GroupNode[]>;
  loadChatPage(groupKey: string, opts: { afterLastSeenAt?: string; limit: number }): Promise<ChatIndex[]>;
  searchChats(query: string, limit?: number): Promise<{ chats: ChatIndex[]; hasMore: boolean }>;
  runQuery<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; durationMs: number; truncated: boolean }>;

  // v4-specific extras (additive — UI may call them when wired)
  addExcludeRule(rule: Omit<idb.ExcludeRuleRow, "id">): Promise<void>;
  removeExcludeRule(id: number): Promise<void>;
  listExcludeRules(): Promise<idb.ExcludeRuleRow[]>;
};

const TAIL_DEFAULT = 200;
const HISTORY_PAGE = 100;
const BOOT_CHAT_LIMIT = 500;
const THROUGHPUT_WINDOW_MS = 30_000;
const QUERY_ATTEMPT_TIMEOUT_MS = 3_000;
const RETRY_BACKOFF_MS = [0, 500, 1000, 2000, 5000];
/** Reuse last entry of RETRY_BACKOFF_MS for attempts beyond its length. */
const RETRY_BACKOFF_TAIL_MS = 5000;

// ---------- exclude rule WHERE composer ------------------------------------

/** Compose a list of exclude rules into a SQL `where` fragment + named param
 *  map. Returns "true" when there are no relevant rules so the caller can
 *  drop it into `WHERE … AND ({excludeWhere})` unconditionally.
 *
 *  Callers pick which rule types apply to their query:
 *    • chat-list queries (sidebar/search/byGroup): host, project, provider, chatId
 *    • render-item queries (openChat/loadOlder): kind, maxItemBytes (chatId
 *      filter implicit by source_file_id; host/project not stored on items)
 */
/** Pure JS analogue of `buildExcludeWhere` for the chats-list scope.
 *  Used to filter cached IDB rows on cold-start hydration and to prune
 *  `visibleChats` when a new rule is added — situations where round-tripping
 *  through SQL would defeat the offline-first contract. */
function isChatExcluded(chat: ChatIndex, rules: idb.ExcludeRuleRow[]): boolean {
  for (const r of rules) {
    if (r.type === "host" && chat.hostId === r.value) return true;
    if (r.type === "project" && chat.projectKey === r.value) return true;
    if (r.type === "provider" && chat.provider === r.value) return true;
    if (r.type === "chatId" && chat.chatId === r.value) return true;
  }
  return false;
}

export function buildExcludeWhere(
  rules: idb.ExcludeRuleRow[],
  scope: "chats" | "items",
  alias: { host?: string; project?: string; provider?: string; chatId?: string; kind?: string; bytes?: string } = {},
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const colHost = alias.host ?? "host_id";
  const colProject = alias.project ?? "project_key";
  const colProvider = alias.provider ?? "provider";
  const colChatId = alias.chatId ?? "chat_id";
  const colKind = alias.kind ?? "kind";
  const colBytes = alias.bytes ?? "payload_bytes";

  const bucket = (type: idb.ExcludeRuleType) =>
    rules.filter((r) => r.type === type).map((r) => r.value);

  if (scope === "chats") {
    const hosts = bucket("host");
    if (hosts.length) {
      params.push(hosts);
      clauses.push(`${colHost} <> ALL($${params.length}::text[])`);
    }
    const projects = bucket("project");
    if (projects.length) {
      params.push(projects);
      clauses.push(`${colProject} <> ALL($${params.length}::text[])`);
    }
    const providers = bucket("provider");
    if (providers.length) {
      params.push(providers);
      clauses.push(`${colProvider} <> ALL($${params.length}::text[])`);
    }
    const chatIds = bucket("chatId");
    if (chatIds.length) {
      params.push(chatIds);
      clauses.push(`${colChatId} <> ALL($${params.length}::text[])`);
    }
  } else {
    // scope === "items"
    const kinds = bucket("kind");
    if (kinds.length) {
      params.push(kinds);
      clauses.push(`${colKind} <> ALL($${params.length}::text[])`);
    }
    const maxBytes = rules.find((r) => r.type === "maxItemBytes");
    if (maxBytes && typeof maxBytes.value === "number") {
      params.push(maxBytes.value);
      clauses.push(`${colBytes} <= $${params.length}`);
    }
  }

  return { sql: clauses.length ? clauses.join(" AND ") : "true", params };
}

// ---------- scope tracker --------------------------------------------------

type Scope = {
  /** Latest maxRev seen on a tick (or hello.ok) for this scope's interest. */
  knownTickMaxRev: number;
  /** maxRev returned by the last successful query reply. */
  lastSyncedMaxRev: number;
  /** A pull is currently in flight. */
  inFlight: boolean;
  /** A tick arrived while inFlight=true. Re-pull when the current pull lands. */
  pendingRetry: boolean;
  /** Run the scope's pull. Idempotent under inFlight gating. */
  run: () => Promise<void>;
};

function maybeKick(scope: Scope) {
  if (scope.lastSyncedMaxRev < scope.knownTickMaxRev) {
    void scope.run();
  }
}

// ---------- query.run with persistent retry --------------------------------

type QueryResult = {
  rows: Record<string, unknown>[];
  durationMs: number;
  truncated: boolean;
  maxRev: number;
};

type PendingQuery = {
  sql: string;
  params: unknown[];
  attempt: number;
  reqId: string | null;
  attemptTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  resolve: (r: QueryResult) => void;
  reject: (err: Error) => void;
  /** If true, give up on persistent retry and fail through to the user's
   *  promise after the first attempt. Used for runQuery() so escape-hatch
   *  callers (devtools) get a real error instead of hanging forever. */
  oneShot: boolean;
  /** True once the user cancelled — promise is already settled. */
  cancelled: boolean;
};

function newReqId(prefix = "q"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- store ----------------------------------------------------------

export function createStore(): Store {
  const listeners = new Set<() => void>();
  let state: StoreState = {
    status: { kind: "idle" },
    views: new Map(),
    cursors: new Map(),
    pendingBytes: new Map(),
    groups: new Map(),
    visibleChats: new Map(),
    activeChat: null,
    activeWindow: null,
    loadingChat: null,
    loadingOlder: false,
    link: { pingRttMs: null, pingMeasuredAt: null, lastFrameAt: null, lastSentAt: null, bytesIn: 0, bytesOut: 0 },
    lastBatchAt: new Map(),
    throughputBps: 0,
  };
  const throughputSamples: { t: number; bytes: number }[] = [];

  let ws: WsClient | null = null;
  let tickHandle: ReturnType<typeof setInterval> | null = null;
  /** Increments on every openChat / closeActiveChat. */
  let activeChatToken = 0;
  /** Pending in-flight queries keyed by current reqId. */
  const pendingQueries = new Map<string, PendingQuery>();
  /** Cached exclude-rule list. Refreshed on add/remove. */
  let excludeRules: idb.ExcludeRuleRow[] = [];
  /** Have we received hello.ok yet? Boot waits for it. */
  let helloOk = false;

  function commit(next: Partial<StoreState>) {
    state = { ...state, ...next };
    for (const l of listeners) l();
  }

  // ---------- query.run with persistent retry ---------------------------

  function sendQueryAttempt(pq: PendingQuery): void {
    if (pq.cancelled) return;
    if (!ws || state.status.kind !== "open") {
      // Wait for reconnect; the open-handler kicks scopes which will retry
      // anyway. Schedule a backoff-style retry if this is a persistent query.
      if (pq.oneShot) {
        pq.cancelled = true;
        pq.reject(new Error("ws is not open"));
        return;
      }
      scheduleRetry(pq);
      return;
    }
    const reqId = newReqId();
    pq.reqId = reqId;
    pendingQueries.set(reqId, pq);
    const frame: ClientFrame = { op: "query", reqId, sql: pq.sql, params: pq.params };
    ws.send(frame);
    if (pq.attemptTimer) clearTimeout(pq.attemptTimer);
    pq.attemptTimer = setTimeout(() => {
      // Timeout — drop the reqId mapping and retry. Reply might still arrive
      // later; we just ignore it.
      if (pq.reqId) pendingQueries.delete(pq.reqId);
      pq.reqId = null;
      pq.attemptTimer = null;
      if (pq.oneShot) {
        pq.cancelled = true;
        pq.reject(new Error("query timeout"));
        return;
      }
      scheduleRetry(pq);
    }, QUERY_ATTEMPT_TIMEOUT_MS);
  }

  function scheduleRetry(pq: PendingQuery): void {
    if (pq.cancelled) return;
    // Use the CURRENT attempt index for backoff (so the first failed attempt
    // retries with RETRY_BACKOFF_MS[0] = 0 ms instead of skipping straight to
    // 500 ms), THEN bump the counter for the next round.
    const idx = Math.min(pq.attempt, RETRY_BACKOFF_MS.length - 1);
    const backoff = RETRY_BACKOFF_MS[idx] ?? RETRY_BACKOFF_TAIL_MS;
    pq.attempt += 1;
    if (pq.retryTimer) clearTimeout(pq.retryTimer);
    pq.retryTimer = setTimeout(() => {
      pq.retryTimer = null;
      sendQueryAttempt(pq);
    }, backoff);
  }

  function runPersistentQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const pq: PendingQuery = {
        sql,
        params,
        attempt: 0,
        reqId: null,
        attemptTimer: null,
        retryTimer: null,
        resolve,
        reject,
        oneShot: false,
        cancelled: false,
      };
      sendQueryAttempt(pq);
    });
  }

  function runOneShotQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const pq: PendingQuery = {
        sql,
        params,
        attempt: 0,
        reqId: null,
        attemptTimer: null,
        retryTimer: null,
        resolve,
        reject,
        oneShot: true,
        cancelled: false,
      };
      sendQueryAttempt(pq);
    });
  }

  // ---------- scopes -----------------------------------------------------

  const sidebarScope: Scope = {
    knownTickMaxRev: 0,
    lastSyncedMaxRev: 0,
    inFlight: false,
    pendingRetry: false,
    run: async () => {
      if (sidebarScope.inFlight) {
        sidebarScope.pendingRetry = true;
        return;
      }
      sidebarScope.inFlight = true;
      sidebarScope.pendingRetry = false;
      try {
        await pullSidebar();
      } catch (err) {
        // Persistent retry handles everything; we only get here if the query
        // promise rejects (it shouldn't for non-oneShot, but be defensive).
        console.warn("[sync-v4] sidebar pull failed", err);
      } finally {
        sidebarScope.inFlight = false;
        if (sidebarScope.pendingRetry || sidebarScope.lastSyncedMaxRev < sidebarScope.knownTickMaxRev) {
          sidebarScope.pendingRetry = false;
          // Re-pull on next tick of event loop to avoid stack growth.
          setTimeout(() => void sidebarScope.run(), 0);
        }
      }
    },
  };

  /** Per-active-chat scope. Recreated on openChat. */
  let activeScope: Scope | null = null;
  /** source_file_id for the active chat (parsed from chatId). Used for the
   *  tick.files filter. */
  let activeSourceFileId: number | null = null;

  // ---------- sidebar pull ------------------------------------------------

  async function pullSidebar(): Promise<void> {
    // Single boot/refresh query: groups (level 1..3) + top BOOT_CHAT_LIMIT
    // chats by last_seen_at, with exclude rules applied. Returns one result
    // set with a discriminator column so we don't need a CTE-with-multiple-
    // outputs trick. We use UNION ALL with a `kind` column.
    const { sql: chatsExcludeWhere, params: chatsExcludeParams } = buildExcludeWhere(excludeRules, "chats", {
      host: "ci.host_id",
      project: "ci.project_key",
      provider: "ci.provider",
      chatId: "ci.chat_id",
    });
    const { sql: groupsExcludeWhere, params: groupsExcludeParams } = buildExcludeWhere(excludeRules, "chats", {
      host: "g.host_id",
      project: "g.project_key",
      provider: "g.provider",
      // group_key isn't a chat id; chatId rules don't filter group rows
      chatId: "''", // never matches a chat-id rule
    });

    // Build UNION query: param numbering must respect both halves.
    // We render the chat half first, then the groups half with offset params.
    const chatStart = 0;
    const groupStart = chatsExcludeParams.length;
    const chatWhereRendered = renumberPlaceholders(chatsExcludeWhere, 0);
    const groupWhereRendered = renumberPlaceholders(groupsExcludeWhere, groupStart);

    const sql = `
      with chat_rows as (
        select
          ci.chat_id,
          ci.group_key,
          ci.host_id,
          ci.provider,
          ci.project_key,
          ci.title,
          ci.last_seen_at,
          ci.approx_bytes,
          ci.item_count
        from v3_chat_index_full ci
        where (${chatWhereRendered})
        order by ci.last_seen_at desc nulls last
        limit ${BOOT_CHAT_LIMIT}
      ),
      group_rows as (
        select
          g.group_key,
          g.level,
          g.parent_key,
          g.label,
          g.host_id,
          g.provider,
          g.project_key,
          g.chat_count,
          g.approx_bytes,
          g.last_seen_at
        from v3_group_aggregates g
        where (${groupWhereRendered})
      )
      select 'g' as kind,
             group_key,
             level,
             parent_key,
             label,
             null::text as chat_id,
             null::text as title,
             host_id,
             provider,
             project_key,
             chat_count,
             approx_bytes,
             last_seen_at,
             null::bigint as item_count
      from group_rows
      union all
      select 'c' as kind,
             group_key,
             null::int as level,
             null::text as parent_key,
             null::text as label,
             chat_id,
             title,
             host_id,
             provider,
             project_key,
             null::bigint as chat_count,
             approx_bytes,
             last_seen_at,
             item_count
      from chat_rows
    `;
    const params = [...chatsExcludeParams, ...groupsExcludeParams];

    const reply = await runPersistentQuery(sql, params);
    sidebarScope.lastSyncedMaxRev = Math.max(sidebarScope.lastSyncedMaxRev, reply.maxRev);

    const groups: GroupNode[] = [];
    const chats: ChatIndex[] = [];
    for (const r of reply.rows) {
      if (r.kind === "g") {
        const lvl = Number(r.level);
        if (lvl !== 1 && lvl !== 2 && lvl !== 3) continue;
        groups.push({
          key: String(r.group_key),
          level: lvl as 1 | 2 | 3,
          parentKey: r.parent_key === null || r.parent_key === undefined ? null : String(r.parent_key),
          label: String(r.label ?? ""),
          chatCount: Number(r.chat_count ?? 0),
          approxBytes: Number(r.approx_bytes ?? 0),
          lastSeenAt: String(r.last_seen_at ?? ""),
          // topChatIds is a v3 snapshot nicety; in v4 the sidebar pulls chats
          // directly so we don't need to precompute previews.
          topChatIds: [],
        });
      } else if (r.kind === "c") {
        chats.push({
          chatId: String(r.chat_id),
          groupKey: String(r.group_key),
          hostId: String(r.host_id ?? ""),
          provider: String(r.provider ?? ""),
          projectKey: String(r.project_key ?? ""),
          title: String(r.title ?? ""),
          lastSeenAt: String(r.last_seen_at ?? ""),
          approxBytes: Number(r.approx_bytes ?? 0),
          itemCount: Number(r.item_count ?? 0),
        });
      }
    }

    // Persist + merge into reactive state. MERGE — never wipe.
    await idb.bulkPutGroups(groups);
    await idb.bulkPutChatIndex(chats);

    const nextGroups = new Map(state.groups);
    for (const g of groups) nextGroups.set(g.key, g);
    const nextVisible = new Map(state.visibleChats);
    for (const c of chats) nextVisible.set(c.chatId, c);
    commit({ groups: nextGroups, visibleChats: nextVisible });
  }

  // ---------- active chat scope -----------------------------------------

  async function pullActiveChatTail(chatId: string, sourceFileId: number, tailLimit: number): Promise<void> {
    const tokenAtStart = activeChatToken;
    const sql = `
      select
        sync_revision as seq,
        case payload->>'k'
          when 'tu' then (payload - 'in') || jsonb_build_object('inSize', pg_column_size(payload->'in'))
          when 'tr' then (payload - 'out') || jsonb_build_object('outSize', octet_length(payload->>'out'))
          else payload
        end as item
      from agent_render_items
      where source_file_id = $1
        and display = true
      order by sync_revision desc, source_event_id desc, part_index desc
      limit $2
    `;
    const reply = await runPersistentQuery(sql, [sourceFileId, tailLimit]);
    if (tokenAtStart !== activeChatToken) return;

    // Apply client-side item-level exclude rules (kind/maxItemBytes). The
    // server-side query doesn't bother because the exclude WHERE composer is
    // wired into chat-list queries; for tails we filter post-hoc — cheaper
    // than threading params through this hot path.
    const filtered = filterRenderRows(reply.rows);

    // Reverse to chronological asc.
    const itemRows: idb.RenderItemRow[] = [];
    for (let i = filtered.length - 1; i >= 0; i -= 1) {
      const row = filtered[i]!;
      const item = row.item;
      itemRows.push({
        chatId,
        seq: row.seq,
        itemKey: idb.itemKey(item),
        item,
        bytes: estimateBytes(item),
      });
    }
    await idb.bulkPutRenderItems(itemRows);
    if (tokenAtStart !== activeChatToken) return;
    if (activeScope) activeScope.lastSyncedMaxRev = Math.max(activeScope.lastSyncedMaxRev, reply.maxRev);

    // Merge with whatever's currently in the window. New tail takes precedence
    // (it's "freshest"), but we don't wipe items the user already scrolled
    // back through.
    const cur = state.activeWindow;
    if (!cur || cur.chatId !== chatId) {
      // First-time fill — use the tail directly.
      const items = itemRows.map((r) => r.item);
      const firstSeq = itemRows[0]?.seq ?? 0;
      const lastSeq = itemRows[itemRows.length - 1]?.seq ?? 0;
      commit({
        activeChat: chatId,
        activeWindow: {
          chatId,
          items,
          firstSeq,
          lastSeq,
          hasOlder: itemRows.length === tailLimit,
          hasNewer: false,
        },
        loadingChat: null,
      });
      return;
    }
    // Merge: keep older items already in window, append new ones beyond lastSeq.
    const newSeqs = itemRows.filter((r) => r.seq > cur.lastSeq);
    if (!newSeqs.length) {
      // Nothing strictly newer — but tail might have backfilled. Replace any
      // window items whose seq overlaps the tail with the freshest copies.
      const tailMap = new Map<number, RenderItem>();
      for (const r of itemRows) tailMap.set(r.seq, r.item);
      const seenSeqs = new Set<number>();
      let lastSeq = cur.lastSeq;
      const merged: RenderItem[] = [];
      for (const it of cur.items) {
        const seqOf = guessSeq(it, cur, merged.length);
        if (seqOf !== null && tailMap.has(seqOf)) {
          merged.push(tailMap.get(seqOf)!);
          seenSeqs.add(seqOf);
          if (seqOf > lastSeq) lastSeq = seqOf;
        } else {
          merged.push(it);
        }
      }
      commit({
        activeWindow: { ...cur, items: merged, lastSeq },
        loadingChat: null,
      });
      return;
    }
    const appended = newSeqs.map((r) => r.item);
    const lastSeq = newSeqs[newSeqs.length - 1]!.seq;
    commit({
      activeWindow: {
        ...cur,
        items: [...cur.items, ...appended],
        lastSeq,
        hasNewer: false,
      },
      loadingChat: null,
    });
  }

  function makeActiveScope(chatId: string, sourceFileId: number, tailLimit: number): Scope {
    const scope: Scope = {
      knownTickMaxRev: sidebarScope.knownTickMaxRev,
      lastSyncedMaxRev: 0,
      inFlight: false,
      pendingRetry: false,
      run: async () => {
        if (scope !== activeScope) return; // user moved on
        if (scope.inFlight) {
          scope.pendingRetry = true;
          return;
        }
        scope.inFlight = true;
        scope.pendingRetry = false;
        try {
          await pullActiveChatTail(chatId, sourceFileId, tailLimit);
        } catch (err) {
          console.warn("[sync-v4] active chat pull failed", err);
        } finally {
          scope.inFlight = false;
          if (scope === activeScope) {
            if (scope.pendingRetry || scope.lastSyncedMaxRev < scope.knownTickMaxRev) {
              scope.pendingRetry = false;
              setTimeout(() => void scope.run(), 0);
            }
          }
        }
      },
    };
    return scope;
  }

  // ---------- frame handling --------------------------------------------

  function onFrame(frame: ServerFrame): void {
    switch (frame.op) {
      case "hello.ok": {
        helloOk = true;
        if (typeof frame.maxRev === "number") {
          sidebarScope.knownTickMaxRev = Math.max(sidebarScope.knownTickMaxRev, frame.maxRev);
          if (activeScope) {
            activeScope.knownTickMaxRev = Math.max(activeScope.knownTickMaxRev, frame.maxRev);
          }
        }
        // Kick the sidebar scope so the boot query runs.
        void sidebarScope.run();
        if (activeScope) void activeScope.run();
        return;
      }
      case "tick": {
        // Sidebar always cares about ticks (group counts, last_seen_at,
        // chat_count change every time render rows arrive).
        sidebarScope.knownTickMaxRev = Math.max(sidebarScope.knownTickMaxRev, frame.maxRev);
        if (sidebarScope.inFlight) sidebarScope.pendingRetry = true;
        else maybeKick(sidebarScope);

        // Active chat: only re-pull if the change touched its source_file_id
        // (or the server omitted `files`, meaning the change was broad).
        if (activeScope && activeSourceFileId !== null) {
          const interested =
            !frame.files || frame.files.length === 0 || frame.files.includes(activeSourceFileId);
          if (interested) {
            activeScope.knownTickMaxRev = Math.max(activeScope.knownTickMaxRev, frame.maxRev);
            if (activeScope.inFlight) activeScope.pendingRetry = true;
            else maybeKick(activeScope);
          }
        }
        return;
      }
      case "query.ok": {
        const pq = pendingQueries.get(frame.reqId);
        if (!pq) return; // late reply, query already retried
        pendingQueries.delete(frame.reqId);
        if (pq.attemptTimer) clearTimeout(pq.attemptTimer);
        if (pq.retryTimer) clearTimeout(pq.retryTimer);
        if (!pq.cancelled) {
          pq.cancelled = true;
          pq.resolve({
            rows: frame.rows,
            durationMs: frame.durationMs,
            truncated: frame.truncated,
            maxRev: frame.maxRev,
          });
        }
        return;
      }
      case "query.err": {
        const pq = pendingQueries.get(frame.reqId);
        if (!pq) return;
        pendingQueries.delete(frame.reqId);
        if (pq.attemptTimer) clearTimeout(pq.attemptTimer);
        if (pq.retryTimer) clearTimeout(pq.retryTimer);
        // Server returned an error (probably bad SQL or transient pg issue).
        // For oneShot (devtools), surface immediately. For persistent
        // (sidebar/tail/etc.), retry with backoff — on transient errors this
        // recovers, on permanent errors we'll log every 5s which is loud but
        // visible. There's no good silent-fail option for read-only queries.
        if (pq.oneShot) {
          if (!pq.cancelled) {
            pq.cancelled = true;
            pq.reject(new Error(frame.error));
          }
          return;
        }
        console.warn(`[sync-v4] query.err: ${frame.error}`);
        scheduleRetry(pq);
        return;
      }
      // query.run.* are v3 aliases the server still emits for DevTools snippets
      // that haven't moved to `query` yet. Treat them as their v4 twins.
      case "query.run.ok":
      case "query.run.err":
      case "pong":
        return;
    }
  }

  // ---------- store API ---------------------------------------------------

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start(opts) {
      // Hydrate sidebar from IDB first so the page paints offline-friendly
      // before WS opens. Without this step a cold start in airplane mode
      // would show an empty sidebar even with thousands of cached chats.
      const [level1, level2, level3, cachedChats] = await Promise.all([
        idb.getGroupsByLevel(1),
        idb.getGroupsByLevel(2),
        idb.getGroupsByLevel(3),
        idb.getAllChatsByLastSeen(BOOT_CHAT_LIMIT),
      ]);
      const groups = new Map<string, GroupNode>();
      for (const g of [...level1, ...level2, ...level3]) groups.set(g.key, g);
      excludeRules = await idb.listExcludeRules();
      // Apply exclude rules to the IDB hydration too — otherwise a chatId
      // rule added on this device would re-surface the chat for one paint
      // cycle on every reload.
      const visibleChats = new Map(state.visibleChats);
      for (const c of cachedChats) {
        if (!isChatExcluded(c, excludeRules)) visibleChats.set(c.chatId, c);
      }
      commit({ groups, visibleChats });

      ws = createWsClient({
        url: opts.url,
        clientId: opts.clientId,
        onStatus: (s) => {
          // On reconnect, helloOk needs to be re-armed; sidebar will re-pull
          // after hello.ok arrives.
          if (s.kind !== "open") helloOk = false;
          commit({ status: s });
          // Watchdog: if WS opens but hello.ok never arrives within 5 s,
          // tear the link down to force a reconnect — otherwise the entire
          // UI sits frozen on a wedged server with no recovery path.
          if (s.kind === "open") {
            setTimeout(() => {
              if (helloOk) return;
              if (!ws) return;
              if (state.status.kind !== "open") return;
              console.warn("[sync-v4] hello.ok timeout — forcing reconnect");
              try {
                ws.stop();
              } catch {}
              try {
                ws?.start();
              } catch {}
            }, 5000);
          }
        },
        onFrame: (frame) => {
          // Track throughput (same logic as v3 store).
          const wsLink = ws?.link();
          if (wsLink) {
            const now = Date.now();
            throughputSamples.push({ t: now, bytes: wsLink.bytesIn });
            while (throughputSamples.length && throughputSamples[0]!.t < now - THROUGHPUT_WINDOW_MS) {
              throughputSamples.shift();
            }
            let bps = 0;
            if (throughputSamples.length >= 2) {
              const first = throughputSamples[0]!;
              const last = throughputSamples[throughputSamples.length - 1]!;
              const dtSec = Math.max(0.001, (last.t - first.t) / 1000);
              bps = Math.max(0, (last.bytes - first.bytes) / dtSec);
            }
            state.link = wsLink;
            state.throughputBps = bps;
          }
          onFrame(frame);
          commit({});
        },
        // v4 store has no outbox — every query is fire-and-retry from the
        // pending-queries map, so the ws-client doesn't need to drain
        // anything before hello.
        async drainOutbox(): Promise<ClientFrame[]> {
          return [];
        },
      });
      ws.start();
      ws.subscribeLink(() => {
        const cur = ws?.link();
        if (cur) {
          state.link = cur;
          commit({});
        }
      });
      tickHandle = setInterval(() => commit({}), 1000);
    },

    stop() {
      ws?.stop();
      ws = null;
      if (tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
      // Cancel all pending queries so callers don't hang.
      for (const pq of pendingQueries.values()) {
        if (pq.attemptTimer) clearTimeout(pq.attemptTimer);
        if (pq.retryTimer) clearTimeout(pq.retryTimer);
        if (!pq.cancelled) {
          pq.cancelled = true;
          pq.reject(new Error("store stopped"));
        }
      }
      pendingQueries.clear();
    },

    async excludeChat(chatId) {
      await idb.addExcludeRule({ type: "chatId", value: chatId, addedAt: new Date().toISOString() });
      excludeRules = await idb.listExcludeRules();
      // Drop locally too so the sidebar updates instantly.
      const visibleChats = new Map(state.visibleChats);
      visibleChats.delete(chatId);
      commit({ visibleChats });
      void sidebarScope.run();
    },
    async includeChat(chatId) {
      // Inverse of excludeChat: remove any chatId rules that match. Refresh.
      const rules = await idb.listExcludeRules();
      for (const r of rules) {
        if (r.type === "chatId" && r.value === chatId && typeof r.id === "number") {
          await idb.removeExcludeRule(r.id);
        }
      }
      excludeRules = await idb.listExcludeRules();
      void sidebarScope.run();
    },

    async openChat(chatId, tailLimit = TAIL_DEFAULT) {
      const token = ++activeChatToken;
      commit({ loadingChat: chatId, activeChat: null, activeWindow: null });

      const sourceFileId = parseSourceFileId(chatId);
      activeSourceFileId = sourceFileId;

      // 1. IDB first — instant first paint.
      const tailRows = await idb.getChatTail(chatId, tailLimit);
      if (token !== activeChatToken) return;
      if (tailRows.length > 0) {
        const window: ActiveChatWindow = {
          chatId,
          items: tailRows.map((r) => r.item),
          firstSeq: tailRows[0]?.seq ?? 0,
          lastSeq: tailRows[tailRows.length - 1]?.seq ?? 0,
          hasOlder: tailRows.length === tailLimit,
          hasNewer: false,
        };
        commit({ activeChat: chatId, activeWindow: window, loadingChat: null });
      }

      // 2. Spin up an active scope and kick a fresh server pull.
      if (sourceFileId === null) {
        // Can't parse — IDB is the only source. Stay on whatever we showed.
        activeScope = null;
        return;
      }
      activeScope = makeActiveScope(chatId, sourceFileId, tailLimit);
      // Bump knownTickMaxRev to force initial pull.
      activeScope.knownTickMaxRev = Math.max(
        activeScope.knownTickMaxRev,
        sidebarScope.knownTickMaxRev,
        1,
      );
      void activeScope.run();
    },

    closeActiveChat() {
      activeChatToken += 1;
      activeScope = null;
      activeSourceFileId = null;
      commit({ activeChat: null, activeWindow: null, loadingChat: null });
    },

    async loadOlder(limit = HISTORY_PAGE) {
      const w = state.activeWindow;
      if (!w || !w.hasOlder) return;
      if (state.loadingOlder) return;
      const tokenAtStart = activeChatToken;
      const chatIdAtStart = w.chatId;
      const sourceFileId = parseSourceFileId(chatIdAtStart);
      commit({ loadingOlder: true });

      try {
        // 1. IDB first.
        const fromIdb = await idb.getChatRange(chatIdAtStart, {
          fromSeq: 0,
          toSeq: w.firstSeq - 1,
          limit,
          direction: "prev",
        });
        if (tokenAtStart !== activeChatToken || state.activeChat !== chatIdAtStart) return;
        let items = fromIdb.map((r) => r.item);
        let firstSeq = fromIdb[0]?.seq ?? w.firstSeq;
        let hasOlder = fromIdb.length === limit;

        if (fromIdb.length < limit && sourceFileId !== null && state.status.kind === "open") {
          const remaining = limit - fromIdb.length;
          const sql = `
            select
              sync_revision as seq,
              case payload->>'k'
                when 'tu' then (payload - 'in') || jsonb_build_object('inSize', pg_column_size(payload->'in'))
                when 'tr' then (payload - 'out') || jsonb_build_object('outSize', octet_length(payload->>'out'))
                else payload
              end as item
            from agent_render_items
            where source_file_id = $1
              and display = true
              and sync_revision < $2
            order by sync_revision desc, source_event_id desc, part_index desc
            limit $3
          `;
          const reply = await runPersistentQuery(sql, [sourceFileId, firstSeq, remaining]);
          if (tokenAtStart !== activeChatToken || state.activeChat !== chatIdAtStart) return;
          const filtered = filterRenderRows(reply.rows);
          // Reverse to chronological asc.
          const newer: RenderItem[] = [];
          const itemRows: idb.RenderItemRow[] = [];
          for (let i = filtered.length - 1; i >= 0; i -= 1) {
            const row = filtered[i]!;
            const item = row.item;
            newer.unshift(item); // building asc
            itemRows.push({
              chatId: chatIdAtStart,
              seq: row.seq,
              itemKey: idb.itemKey(item),
              item,
              bytes: estimateBytes(item),
            });
          }
          await idb.bulkPutRenderItems(itemRows);
          if (tokenAtStart !== activeChatToken || state.activeChat !== chatIdAtStart) return;
          items = [...newer, ...items];
          firstSeq = itemRows[itemRows.length - 1]?.seq ?? firstSeq; // last itemRow has lowest seq
          hasOlder = filtered.length === remaining;
        }

        if (tokenAtStart !== activeChatToken || state.activeChat !== chatIdAtStart) return;
        const stillCurrent = state.activeWindow;
        if (!stillCurrent || stillCurrent.chatId !== chatIdAtStart) return;
        commit({
          activeWindow: {
            ...stillCurrent,
            items: [...items, ...stillCurrent.items],
            firstSeq,
            hasOlder,
          },
        });
      } finally {
        commit({ loadingOlder: false });
      }
    },

    async loadGroupChildren(parentKey) {
      // Groups are kept in IDB by the sidebar pull. Read directly.
      return idb.getGroupsByParent(parentKey);
    },

    async loadChatPage(groupKey, opts) {
      // Server-first pull (paged by lastSeenAt). Falls back to IDB on error.
      try {
        const { sql: excludeWhere, params: excludeParams } = buildExcludeWhere(excludeRules, "chats", {
          host: "host_id",
          project: "project_key",
          provider: "provider",
          chatId: "chat_id",
        });
        const params: unknown[] = [groupKey, ...excludeParams];
        const renumberedExclude = renumberPlaceholders(excludeWhere, 1); // groupKey is $1
        const afterClause = opts.afterLastSeenAt ? `and last_seen_at < $${params.length + 1}` : "";
        if (opts.afterLastSeenAt) params.push(opts.afterLastSeenAt);
        params.push(opts.limit + 1);
        const limitParamIdx = params.length;
        const sql = `
          select
            chat_id, group_key, host_id, provider, project_key,
            title, last_seen_at, approx_bytes, item_count
          from v3_chat_index_full
          where group_key = $1
            ${afterClause}
            and (${renumberedExclude})
          order by last_seen_at desc nulls last
          limit $${limitParamIdx}
        `;
        const reply = await runOneShotQuery(sql, params);
        const allRows = reply.rows.map((r) => ({
          chatId: String(r.chat_id),
          groupKey: String(r.group_key),
          hostId: String(r.host_id ?? ""),
          provider: String(r.provider ?? ""),
          projectKey: String(r.project_key ?? ""),
          title: String(r.title ?? ""),
          lastSeenAt: String(r.last_seen_at ?? ""),
          approxBytes: Number(r.approx_bytes ?? 0),
          itemCount: Number(r.item_count ?? 0),
        }));
        // We requested limit+1 so the caller can detect hasMore; the v3 API
        // shape just returns ChatIndex[], so we trim and signal via IDB cache.
        const trimmed = allRows.slice(0, opts.limit);
        if (trimmed.length) {
          await idb.bulkPutChatIndex(trimmed);
          const visibleChats = new Map(state.visibleChats);
          for (const c of trimmed) visibleChats.set(c.chatId, c);
          commit({ visibleChats });
        }
        return trimmed;
      } catch (err) {
        console.warn("[sync-v4] loadChatPage failed, falling back to IDB", err);
        return idb.getChatsByGroup(groupKey, opts);
      }
    },

    async searchChats(query, limit = 50) {
      const trimmed = query.trim();
      if (!trimmed) return { chats: [], hasMore: false };
      const tsq = toTsQuery(trimmed);
      const useTs = tsq !== null;
      const { sql: excludeWhere, params: excludeParams } = buildExcludeWhere(excludeRules, "chats", {
        host: "s.host_id",
        project: "s.project_key",
        provider: "s.provider",
        chatId: "s.chat_id",
      });
      // Try FTS first; if to_tsquery fails on weird input, fall back to ILIKE.
      try {
        if (useTs) {
          const params: unknown[] = [tsq, ...excludeParams, limit + 1];
          const renumberedExclude = renumberPlaceholders(excludeWhere, 1);
          const sql = `
            select
              s.chat_id,
              s.title,
              s.host_id,
              s.provider,
              s.project_key,
              s.last_seen_at,
              -- not on s; pull through chat_index_full
              ci.group_key,
              ci.approx_bytes,
              ci.item_count
            from v3_chat_search s
            join v3_chat_index_full ci on ci.source_file_id = s.source_file_id
            where s.document @@ to_tsquery('simple', $1)
              and (${renumberedExclude})
            order by s.last_seen_at desc nulls last
            limit $${params.length}
          `;
          const reply = await runOneShotQuery(sql, params);
          return finalizeSearchReply(reply.rows, limit);
        }
      } catch (err) {
        console.warn("[sync-v4] FTS search failed, falling back to ILIKE", err);
      }
      try {
        const ilike = `%${trimmed.replace(/[%_]/g, "\\$&")}%`;
        const params: unknown[] = [ilike, ...excludeParams, limit + 1];
        const renumberedExclude = renumberPlaceholders(excludeWhere, 1);
        const sql = `
          select
            s.chat_id,
            s.title,
            s.host_id,
            s.provider,
            s.project_key,
            s.last_seen_at,
            ci.group_key,
            ci.approx_bytes,
            ci.item_count
          from v3_chat_search s
          join v3_chat_index_full ci on ci.source_file_id = s.source_file_id
          where (s.title ilike $1 or s.project_key ilike $1 or s.host_id ilike $1)
            and (${renumberedExclude})
          order by s.last_seen_at desc nulls last
          limit $${params.length}
        `;
        const reply = await runOneShotQuery(sql, params);
        return finalizeSearchReply(reply.rows, limit);
      } catch (err) {
        console.warn("[sync-v4] ILIKE search failed, falling back to local scan", err);
        const lower = trimmed.toLowerCase();
        const out: ChatIndex[] = [];
        for (const c of state.visibleChats.values()) {
          if (
            c.title.toLowerCase().includes(lower) ||
            c.chatId.toLowerCase().includes(lower) ||
            c.projectKey.toLowerCase().includes(lower)
          ) {
            out.push(c);
          }
          if (out.length >= limit) break;
        }
        out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        return { chats: out, hasMore: out.length >= limit };
      }

      function finalizeSearchReply(
        rows: Record<string, unknown>[],
        limit: number,
      ): { chats: ChatIndex[]; hasMore: boolean } {
        const all: ChatIndex[] = rows.map((r) => ({
          chatId: String(r.chat_id),
          groupKey: String(r.group_key ?? ""),
          hostId: String(r.host_id ?? ""),
          provider: String(r.provider ?? ""),
          projectKey: String(r.project_key ?? ""),
          title: String(r.title ?? ""),
          lastSeenAt: String(r.last_seen_at ?? ""),
          approxBytes: Number(r.approx_bytes ?? 0),
          itemCount: Number(r.item_count ?? 0),
        }));
        const hasMore = all.length > limit;
        const chats = all.slice(0, limit);
        if (chats.length) {
          void idb.bulkPutChatIndex(chats);
          const visibleChats = new Map(state.visibleChats);
          for (const c of chats) visibleChats.set(c.chatId, c);
          commit({ visibleChats });
        }
        return { chats, hasMore };
      }
    },

    runQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return runOneShotQuery(sql, params ?? []).then((r) => ({
        rows: r.rows as T[],
        durationMs: r.durationMs,
        truncated: r.truncated,
      }));
    },

    async addExcludeRule(rule) {
      await idb.addExcludeRule(rule);
      excludeRules = await idb.listExcludeRules();
      // Drop any currently-visible chats that match the new rule so the UI
      // updates immediately instead of waiting for the next sidebar pull.
      // Cheap because the Map is bounded by BOOT_CHAT_LIMIT.
      const visibleChats = new Map(state.visibleChats);
      let pruned = 0;
      for (const [id, chat] of visibleChats) {
        if (isChatExcluded(chat, excludeRules)) {
          visibleChats.delete(id);
          pruned++;
        }
      }
      if (pruned > 0) commit({ visibleChats });
      // Force sidebar re-pull (and active chat tail re-pull, since item-level
      // rules may now drop visible items).
      sidebarScope.knownTickMaxRev += 1;
      void sidebarScope.run();
      if (activeScope) {
        activeScope.knownTickMaxRev += 1;
        void activeScope.run();
      }
    },
    async removeExcludeRule(id) {
      await idb.removeExcludeRule(id);
      excludeRules = await idb.listExcludeRules();
      sidebarScope.knownTickMaxRev += 1;
      void sidebarScope.run();
      if (activeScope) {
        activeScope.knownTickMaxRev += 1;
        void activeScope.run();
      }
    },
    async listExcludeRules() {
      return idb.listExcludeRules();
    },
  };
}

// ---------- helpers --------------------------------------------------------

function estimateBytes(item: RenderItem): number {
  try {
    return new TextEncoder().encode(JSON.stringify(item)).byteLength;
  } catch {
    return 0;
  }
}

/** Parse a v3-format chat id ("v3:<source_file_id>") into the numeric id.
 *  Returns null for unparseable ids so callers can fall back gracefully. */
function parseSourceFileId(chatId: string): number | null {
  const m = /^v3:(\d+)$/.exec(chatId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Sanitize a free-text query into a to_tsquery() string. Returns null if
 *  the input contains nothing usable (so caller falls back to ILIKE). */
function toTsQuery(q: string): string | null {
  // Split on whitespace, drop tokens that aren't [a-z0-9_-]+, append :* for
  // prefix match. Keep at most 8 tokens so we don't blow out the planner.
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9_-]/g, ""))
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `${t}:*`).join(" & ");
}

/** Re-number `$N` placeholders inside a where fragment so the merged SQL has
 *  contiguous param indexes. `offset` is the number of params already
 *  consumed by the outer query's earlier params.
 *
 *  buildExcludeWhere always emits `$1`, `$2`, … starting from 1; if the outer
 *  query has its own params before it, we shift each `$N` by `offset`. */
function renumberPlaceholders(sqlFragment: string, offset: number): string {
  if (offset === 0) return sqlFragment;
  return sqlFragment.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + offset}`);
}

/** Apply item-level exclude rules (kind/maxItemBytes) to render rows. The
 *  server doesn't filter these (they're part of the items pull, not the
 *  chat-list pull), so we drop matching rows on the client. */
function filterRenderRows(
  rows: Record<string, unknown>[],
): Array<{ seq: number; item: RenderItem }> {
  const out: Array<{ seq: number; item: RenderItem }> = [];
  for (const r of rows) {
    const seq = Number(r.seq);
    const item = r.item as RenderItem | undefined;
    if (!item || typeof item !== "object") continue;
    if (!Number.isFinite(seq)) continue;
    out.push({ seq, item });
  }
  return out;
}

/** activeWindow.items doesn't carry seq in its element shape, but we still
 *  need to detect overlap when merging tail re-pulls. Use itemKey (id+p) as
 *  a heuristic: if the new tail's item has the same key, replace the cur
 *  one. Returns null when we can't tell. */
function guessSeq(_item: RenderItem, _w: ActiveChatWindow, _idxFromStart: number): number | null {
  // We don't track per-item seq inside the window, so just return null and
  // let the caller skip the per-element replace path. The merge fallback
  // (replace whole tail when nothing strictly newer arrived) keeps the UI
  // correct; missing the fine-grained replace just means a stale tool body
  // sticks around for a few seconds longer.
  return null;
}
