// Server-side data access for sync-v3.
//
// Здесь вся работа с Postgres для нового стека: snapshot подписки, инкрементальная
// дельта, history-range, чтение групп. Все запросы используют resolvePredicate
// для безопасной подстановки.

import type {
  ChatIndex,
  GroupNode,
  RenderItem,
  SeqRenderItem,
  ViewSpec,
} from "../../../packages/sync-v3/contracts";
import { resolvePredicate, v3SessionIdFromSourceFileId, parseV3SessionId } from "./view-resolver";

// Snapshot защищён жёстким лимитом — это первый фрейм, отдаётся через WS.
// Никаких "сэндвичей" на 12 МБ: серверу легко, клиенту тяжело.
//   • DEFAULT_TAIL_ITEMS=0 — снэпшот несёт только мету, тейлы тянутся через
//     history.range когда юзер реально откроет чат.
//   • MAX_SNAPSHOT_CHATS — клиент видит верхушку (по lastSeenAt), остальное
//     грузится paged через chat_index при скролле.
const DEFAULT_TAIL_ITEMS = 0;
const MAX_TAIL_ITEMS = 200;
const MAX_HISTORY_LIMIT = 500;
const MAX_SNAPSHOT_CHATS = 500;

export type SnapshotResult = {
  /** max sync_revision included in this snapshot */
  cursor: number;
  /** group tree (host > provider > project) for chats inside this view */
  groups: GroupNode[];
  /** chat index for chats inside this view, sorted by lastSeenAt desc */
  chats: ChatIndex[];
  /** per-chat tail of items with their real sync_revision-derived seq */
  tails: Record<string, SeqRenderItem[]>;
  totals: { items: number; bytesRemaining: number };
};

export type DeltaResult = {
  cursor: number;
  items: { chatId: string; item: RenderItem; seq: number }[];
  bytesRemaining: number;
  moreReady: boolean;
};

export type Repo = {
  buildSnapshot(view: ViewSpec): Promise<SnapshotResult>;
  fetchDelta(view: ViewSpec, sinceCursor: number, limitBytes?: number): Promise<DeltaResult>;
  fetchHistoryRange(opts: HistoryRangeOpts): Promise<{ items: SeqRenderItem[]; hasOlder: boolean; hasNewer: boolean }>;
  /** Find which views (by client_id+view_id) include a given chat right now. */
  resolveMatchingViews(sourceFileId: number): Promise<ResolvedViewMatch[]>;
  /** Fetch the freshest tail items for a chat (used by chat.added handler). */
  fetchChatTailById(sourceFileId: number, limit: number): Promise<SeqRenderItem[]>;
  /** Build a single ChatIndex row for a chat (used by chat.added handler). */
  fetchChatIndex(sourceFileId: number): Promise<ChatIndex | null>;
  bytesRemainingForView(view: ViewSpec, cursor: number): Promise<number>;
  refreshGroupAggregates(): Promise<void>;
};

export type HistoryRangeOpts = {
  chatId: string;
  /** events with sync_revision < this cursor */
  before?: number;
  /** events with sync_revision > this cursor */
  after?: number;
  limit: number;
};

export type ResolvedViewMatch = {
  clientId: string;
  viewId: string;
  /** true if this chat is already a member of this view (pre-existing); */
  /** false means the chat newly matches and triggers chat.added emission. */
  alreadyMember: boolean;
};

export function makeRepo(sql: any): Repo {
  return {
    buildSnapshot: (view) => buildSnapshot(sql, view),
    fetchDelta: (view, since, limitBytes) => fetchDelta(sql, view, since, limitBytes ?? 64 * 1024),
    fetchHistoryRange: (opts) => fetchHistoryRange(sql, opts),
    bytesRemainingForView: (view, cursor) => bytesRemainingForView(sql, view, cursor),
    refreshGroupAggregates: () => refreshGroupAggregates(sql),
    resolveMatchingViews: (sourceFileId) => resolveMatchingViews(sql, sourceFileId),
    fetchChatTailById: (sourceFileId, limit) => fetchChatTail(sql, sourceFileId, limit),
    fetchChatIndex: (sourceFileId) => fetchChatIndex(sql, sourceFileId),
  };
}

async function buildSnapshot(sql: any, view: ViewSpec): Promise<SnapshotResult> {
  const tailItems = clampTail(view.history?.tailItems);
  const resolved = resolvePredicate(view.predicate, 1);

  // 1. Find matching chats (deduplicated via DISTINCT) + their meta.
  // CTE pre-extracts projectKey/title from metadata so they're plain columns
  // for GROUP BY (Postgres won't accept jsonb expressions through aliases there).
  const chats = await sql.unsafe(
    `
    with src as (
      select
        r.source_file_id,
        r.sync_revision,
        f.agent_id,
        f.provider,
        coalesce(nullif(f.metadata->>'projectKey', ''), '(unknown)') as project_key,
        coalesce(nullif(f.metadata->>'title', ''), nullif(f.metadata->>'projectName', ''), nullif(f.metadata->>'projectKey', ''), '(no title)') as title,
        f.last_seen_at,
        f.size_bytes
      from agent_render_items r
      join agent_source_files f on f.id = r.source_file_id
      where r.display = true
        and f.deleted_at is null
        and (${resolved.sql})
        ${excludesClause(view, resolved.params.length + 1)}
    )
    select
      source_file_id,
      agent_id,
      provider,
      project_key,
      title,
      last_seen_at,
      size_bytes,
      max(sync_revision) as max_seq,
      count(*) as item_count
    from src
    group by source_file_id, agent_id, provider, project_key, title, last_seen_at, size_bytes
    order by last_seen_at desc
    limit ${MAX_SNAPSHOT_CHATS}
    `,
    [...resolved.params, ...excludesParams(view)],
  );

  if (chats.length === 0) {
    return { cursor: 0, groups: [], chats: [], tails: {}, totals: { items: 0, bytesRemaining: 0 } };
  }

  const chatIndex: ChatIndex[] = chats.map((row: any) => ({
    chatId: v3SessionIdFromSourceFileId(row.source_file_id),
    groupKey: groupKeyFor(row.agent_id, row.provider, row.project_key),
    hostId: row.agent_id,
    provider: row.provider,
    projectKey: row.project_key,
    title: row.title,
    lastSeenAt: toISO(row.last_seen_at),
    approxBytes: Number(row.size_bytes ?? 0),
    itemCount: Number(row.item_count ?? 0),
  }));

  const cursor = chats.reduce((max: number, r: any) => Math.max(max, Number(r.max_seq ?? 0)), 0);

  // 2. Per-chat tail of RenderItems (если tailItems > 0)
  const tails: Record<string, SeqRenderItem[]> = {};
  if (tailItems > 0) {
    for (const chat of chatIndex) {
      tails[chat.chatId] = await fetchChatTail(sql, parseV3SessionId(chat.chatId)!, tailItems);
    }
  }

  // 3. Group aggregates limited to chats in view
  const groups = await fetchGroupsForChats(sql, chatIndex);

  // 4. Bytes remaining = bytes in this view above current cursor (zero on snapshot since
  //    we just delivered up to cursor, but for completeness recompute).
  const bytesRemaining = 0;

  return {
    cursor,
    groups,
    chats: chatIndex,
    tails,
    totals: { items: chatIndex.reduce((s, c) => s + c.itemCount, 0), bytesRemaining },
  };
}

async function fetchChatTail(sql: any, sourceFileId: number, limit: number): Promise<SeqRenderItem[]> {
  const rows = await sql`
    select payload, sync_revision
    from agent_render_items
    where source_file_id = ${sourceFileId}
      and display = true
    order by sync_revision desc, source_event_id desc, part_index desc
    limit ${Math.min(limit, MAX_TAIL_ITEMS)}
  `;
  // Возвращаем в хронологическом порядке (старое → новое)
  return rows
    .map((r: any) => ({ item: r.payload as RenderItem, seq: Number(r.sync_revision) }))
    .reverse();
}

async function fetchChatIndex(sql: any, sourceFileId: number): Promise<ChatIndex | null> {
  const rows = await sql`
    select
      f.id,
      f.agent_id,
      f.provider,
      coalesce(nullif(f.metadata->>'projectKey', ''), '(unknown)') as project_key,
      coalesce(nullif(f.metadata->>'title', ''), nullif(f.metadata->>'projectName', ''), nullif(f.metadata->>'projectKey', ''), '(no title)') as title,
      f.last_seen_at,
      f.size_bytes,
      coalesce((select count(*) from agent_render_items r where r.source_file_id = f.id and r.display = true), 0) as item_count
    from agent_source_files f
    where f.id = ${sourceFileId} and f.deleted_at is null
  `;
  if (!rows.length) return null;
  const row = rows[0];
  return {
    chatId: v3SessionIdFromSourceFileId(row.id),
    groupKey: groupKeyFor(row.agent_id, row.provider, row.project_key),
    hostId: row.agent_id,
    provider: row.provider,
    projectKey: row.project_key,
    title: row.title,
    lastSeenAt: toISO(row.last_seen_at),
    approxBytes: Number(row.size_bytes ?? 0),
    itemCount: Number(row.item_count ?? 0),
  };
}

async function resolveMatchingViews(sql: any, sourceFileId: number): Promise<ResolvedViewMatch[]> {
  // Получаем все client_views и применяем predicate к этому конкретному чату.
  // Predicate eval делаем в SQL через resolvePredicate + EXISTS.
  // На малом числе подписок (5 клиентов × ~5 view) это быстро.
  const views = await sql`
    select v.client_id, v.view_id, v.spec
    from client_views v
  `;
  const result: ResolvedViewMatch[] = [];
  for (const row of views) {
    const spec = row.spec as ViewSpec;
    if ((spec.excludes ?? []).includes(v3SessionIdFromSourceFileId(sourceFileId))) continue;
    const includes = (spec.includes ?? []).includes(v3SessionIdFromSourceFileId(sourceFileId));
    let matches = includes;
    if (!matches) {
      const resolved = resolvePredicate(spec.predicate, 1);
      const params = [...resolved.params, sourceFileId];
      const sourceParamIdx = resolved.params.length + 1;
      const matchRows = await sql.unsafe(
        `select 1 from agent_render_items r
         join agent_source_files f on f.id = r.source_file_id
         where r.source_file_id = $${sourceParamIdx}
           and r.display = true
           and (${resolved.sql})
         limit 1`,
        params,
      );
      matches = matchRows.length > 0;
    }
    if (!matches) continue;

    // Membership: смотрим client_view_chats
    const memberRows = await sql`
      select 1 from client_view_chats
      where client_id = ${row.client_id}
        and view_id = ${row.view_id}
        and source_file_id = ${sourceFileId}
      limit 1
    `;
    result.push({
      clientId: String(row.client_id),
      viewId: String(row.view_id),
      alreadyMember: memberRows.length > 0,
    });
  }
  return result;
}

async function fetchDelta(sql: any, view: ViewSpec, sinceCursor: number, limitBytes: number): Promise<DeltaResult> {
  const resolved = resolvePredicate(view.predicate, 1);
  const params: unknown[] = [...resolved.params, sinceCursor, ...excludesParams(view)];
  const sinceParamIdx = resolved.params.length + 1;

  // Pull events strictly above sinceCursor, ordered by sync_revision asc (forward).
  // Grab up to ~limitBytes / avg-item-size events; cap by row count too.
  const maxRows = 500;
  const rows = await sql.unsafe(
    `
    select
      r.source_file_id,
      r.sync_revision,
      r.source_event_id,
      r.part_index,
      r.payload,
      r.payload_bytes
    from agent_render_items r
    join agent_source_files f on f.id = r.source_file_id
    where r.display = true
      and f.deleted_at is null
      and r.sync_revision > $${sinceParamIdx}
      and (${resolved.sql})
      ${excludesClause(view, sinceParamIdx + 1)}
    order by r.sync_revision asc, r.source_event_id asc, r.part_index asc
    limit ${maxRows}
    `,
    params,
  );

  let totalBytes = 0;
  const items: DeltaResult["items"] = [];
  let cursor = sinceCursor;
  for (const row of rows) {
    if (totalBytes >= limitBytes) break;
    const seq = Number(row.sync_revision);
    items.push({
      chatId: v3SessionIdFromSourceFileId(row.source_file_id),
      item: row.payload as RenderItem,
      seq,
    });
    totalBytes += Number(row.payload_bytes ?? 0);
    cursor = seq;
  }

  const bytesRemaining = await bytesRemainingForView(sql, view, cursor);
  return {
    cursor,
    items,
    bytesRemaining,
    moreReady: bytesRemaining > 0,
  };
}

async function bytesRemainingForView(sql: any, view: ViewSpec, cursor: number): Promise<number> {
  const resolved = resolvePredicate(view.predicate, 1);
  const params: unknown[] = [...resolved.params, cursor, ...excludesParams(view)];
  const cursorIdx = resolved.params.length + 1;
  const rows = await sql.unsafe(
    `
    select coalesce(sum(r.payload_bytes), 0)::bigint as total
    from agent_render_items r
    join agent_source_files f on f.id = r.source_file_id
    where r.display = true
      and f.deleted_at is null
      and r.sync_revision > $${cursorIdx}
      and (${resolved.sql})
      ${excludesClause(view, cursorIdx + 1)}
    `,
    params,
  );
  return Number(rows[0]?.total ?? 0);
}

async function fetchHistoryRange(sql: any, opts: HistoryRangeOpts) {
  const sourceFileId = parseV3SessionId(opts.chatId);
  if (sourceFileId === null) return { items: [], hasOlder: false, hasNewer: false };

  const limit = Math.min(Math.max(1, opts.limit), MAX_HISTORY_LIMIT);

  if (opts.before !== undefined) {
    const rows = await sql`
      select payload, sync_revision from agent_render_items
      where source_file_id = ${sourceFileId}
        and display = true
        and sync_revision < ${opts.before}
      order by sync_revision desc
      limit ${limit}
    `;
    const items: SeqRenderItem[] = rows
      .map((r: any) => ({ item: r.payload as RenderItem, seq: Number(r.sync_revision) }))
      .reverse();
    const oldestSeq = rows.length ? Number(rows[rows.length - 1].sync_revision) : opts.before;
    const olderRows = await sql`
      select 1 from agent_render_items
      where source_file_id = ${sourceFileId} and display = true and sync_revision < ${oldestSeq}
      limit 1
    `;
    return { items, hasOlder: olderRows.length > 0, hasNewer: true };
  }

  if (opts.after !== undefined) {
    const rows = await sql`
      select payload, sync_revision from agent_render_items
      where source_file_id = ${sourceFileId}
        and display = true
        and sync_revision > ${opts.after}
      order by sync_revision asc
      limit ${limit}
    `;
    const items: SeqRenderItem[] = rows.map((r: any) => ({
      item: r.payload as RenderItem,
      seq: Number(r.sync_revision),
    }));
    const newestSeq = rows.length ? Number(rows[rows.length - 1].sync_revision) : opts.after;
    const newerRows = await sql`
      select 1 from agent_render_items
      where source_file_id = ${sourceFileId} and display = true and sync_revision > ${newestSeq}
      limit 1
    `;
    return { items, hasOlder: true, hasNewer: newerRows.length > 0 };
  }

  // Tail by default.
  const items = await fetchChatTail(sql, sourceFileId, limit);
  return { items, hasOlder: items.length === limit, hasNewer: false };
}

async function fetchGroupsForChats(sql: any, chats: ChatIndex[]): Promise<GroupNode[]> {
  if (chats.length === 0) return [];
  // Берём из materialized view только узлы, релевантные нашему набору чатов.
  // На малом количестве чатов / групп проще читать всё дерево живущих агентов.
  const hostIds = Array.from(new Set(chats.map((c) => c.hostId)));
  // Bun's tagged-SQL doesn't auto-convert JS arrays to Postgres text[] — pass via ANY(VALUES ...).
  const placeholders = hostIds.map((_, i) => `$${i + 1}`).join(",");
  const rows = await sql.unsafe(
    `select group_key, level, parent_key, label, host_id, provider, project_key,
            chat_count, approx_bytes, last_seen_at
     from v3_group_aggregates
     where host_id in (${placeholders})
     order by level asc, last_seen_at desc nulls last`,
    hostIds,
  );

  // topChatIds для level=3: 5 самых свежих чатов в этом проекте.
  const groupNodes: GroupNode[] = rows.map((r: any) => ({
    key: r.group_key,
    level: Number(r.level) as 1 | 2 | 3,
    parentKey: r.parent_key ?? null,
    label: r.label,
    chatCount: Number(r.chat_count ?? 0),
    approxBytes: Number(r.approx_bytes ?? 0),
    lastSeenAt: toISO(r.last_seen_at),
    topChatIds: [],
  }));

  // Заполняем topChatIds из набора chats (дёшево, без round-trip)
  const projectIndex = new Map<string, ChatIndex[]>();
  for (const c of chats) {
    const list = projectIndex.get(c.groupKey) ?? [];
    list.push(c);
    projectIndex.set(c.groupKey, list);
  }
  for (const node of groupNodes) {
    if (node.level !== 3) continue;
    const list = projectIndex.get(node.key) ?? [];
    node.topChatIds = list
      .slice()
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, 5)
      .map((c) => c.chatId);
  }
  return groupNodes;
}

async function refreshGroupAggregates(sql: any) {
  await sql`refresh materialized view v3_group_aggregates`;
}

// ---------- helpers --------------------------------------------------------

function clampTail(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_TAIL_ITEMS;
  return Math.max(0, Math.min(MAX_TAIL_ITEMS, Math.floor(n)));
}

function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function groupKeyFor(agentId: string, provider: string, projectKey: string): string {
  return `h:${agentId}|p:${provider}|pr:${projectKey}`;
}

function excludesClause(view: ViewSpec, startIdx: number): string {
  if (!view.excludes || view.excludes.length === 0) return "";
  const ids = view.excludes.map(parseV3SessionId).filter((n): n is number => n !== null);
  if (ids.length === 0) return "";
  const placeholders = ids.map((_, i) => `$${startIdx + i}`).join(",");
  return `AND r.source_file_id NOT IN (${placeholders})`;
}

function excludesParams(view: ViewSpec): unknown[] {
  if (!view.excludes) return [];
  return view.excludes.map(parseV3SessionId).filter((n): n is number => n !== null);
}
