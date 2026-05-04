// Server-side data access for sync-v4.
//
// Only four operations remain:
//   • runRawQuery / runRawQueryWithMaxRev — execute arbitrary read-only SQL
//     in a tx with statement_timeout and a row cap. Drives the v4 `query` op.
//   • fetchMaxRev — bootstrap value for the client's tick tracker.
//   • refreshV4MaterializedViews — concurrent refresh of the three MVs the
//     frontend reads (v3_chat_index_full / v3_chat_search / v3_chat_last_render).
//   • refreshGroupAggregates — kept because the ingest path still calls it
//     to keep v3_group_aggregates in sync after each batch.
//
// The v3 snapshot/batch/predicate plumbing (buildSnapshot, fetchDelta,
// fetchHistoryRange, listChatsByGroup, searchChats, resolveMatchingViews,
// fetchChatTailById, fetchChatIndex, bytesRemainingForView) is gone — the
// frontend now drives the equivalent SELECTs itself via `query`.

export type Repo = {
  /** Run an arbitrary SQL string in a read-only transaction with a tight
   *  statement_timeout. Used by the frontend escape hatch (`query` /
   *  `query.run` WS ops) so we can iterate UI features without minting new
   *  RPC operations. Returns row objects keyed by column name. */
  runRawQuery(opts: RunRawQueryOpts): Promise<{ rows: Record<string, unknown>[]; durationMs: number; truncated: boolean }>;
  /** Same as runRawQuery but also reads `max(sync_revision)` inside the same
   *  read-only transaction. v4 `query` op uses this so the returned rows and
   *  the `maxRev` watermark are race-free with each other. */
  runRawQueryWithMaxRev(opts: RunRawQueryOpts): Promise<{ rows: Record<string, unknown>[]; durationMs: number; truncated: boolean; maxRev: number }>;
  /** Read the largest currently-visible `sync_revision`. Used by hello.ok to
   *  bootstrap the v4 client's tick tracker, and by the notify-listener as a
   *  poll fallback when LISTEN delivery is unavailable. */
  fetchMaxRev(): Promise<number>;
  /** Refresh the v4 chat-index/search/last-render materialized views.
   *  Each view has a unique index so `concurrently` works. Returns once all
   *  three settle (success or failure). Failures are surfaced as the rejected
   *  per-view promise so the caller can warn-log without aborting tick. */
  refreshV4MaterializedViews(): Promise<{ name: string; ok: boolean; error?: string }[]>;
  /** Refresh v3_group_aggregates. Called from the ingest hook after each
   *  batch so the sidebar tree stays current. Cheap: ~milliseconds at
   *  k-row scale. */
  refreshGroupAggregates(): Promise<void>;
};

export type RunRawQueryOpts = {
  sql: string;
  params?: unknown[];
};

/** Hard cap so a `select * from agent_render_items` doesn't fill memory.
 *  When triggered, response is marked `truncated: true` so caller knows. */
const MAX_RAW_QUERY_ROWS = 5000;
/** Per-statement Postgres timeout. Frontend can't deadlock its own backend. */
const RAW_QUERY_STATEMENT_TIMEOUT_MS = 5000;

const V4_MATERIALIZED_VIEWS = ["v3_chat_index_full", "v3_chat_search", "v3_chat_last_render"] as const;

export function makeRepo(sql: any): Repo {
  return {
    runRawQuery: (opts) => runRawQuery(sql, opts),
    runRawQueryWithMaxRev: (opts) => runRawQueryWithMaxRev(sql, opts),
    fetchMaxRev: () => fetchMaxRev(sql),
    refreshV4MaterializedViews: () => refreshV4MaterializedViews(sql),
    refreshGroupAggregates: () => refreshGroupAggregates(sql),
  };
}

async function fetchMaxRev(sql: any): Promise<number> {
  // coalesce keeps the empty-DB case (no render rows) returning 0 instead of
  // null. cast to ::bigint then we normalise to JS number; sync_revision is
  // monotonic per-row so the value fits in JS's 53-bit int range for the
  // foreseeable life of this app.
  const rows = await sql`select coalesce(max(sync_revision), 0)::bigint as m from agent_render_items`;
  const raw = rows[0]?.m ?? 0;
  return typeof raw === "bigint" ? Number(raw) : Number(raw);
}

async function runRawQueryWithMaxRev(
  sql: any,
  opts: RunRawQueryOpts,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number; truncated: boolean; maxRev: number }> {
  const t0 = Date.now();
  const params = Array.isArray(opts.params) ? opts.params : [];
  const result = await sql.transaction(async (tx: any) => {
    await tx.unsafe(`set local transaction read only`);
    await tx.unsafe(`set local statement_timeout = ${RAW_QUERY_STATEMENT_TIMEOUT_MS}`);
    const rows = await tx.unsafe(opts.sql, params);
    // Read maxRev inside the same tx so it's a consistent snapshot with the
    // user's query — the client uses it as a "I have data up to revision X"
    // watermark.
    const mrRows = await tx.unsafe(`select coalesce(max(sync_revision), 0)::bigint as m from agent_render_items`);
    const raw = mrRows?.[0]?.m ?? 0;
    const maxRev = typeof raw === "bigint" ? Number(raw) : Number(raw);
    return { rows: rows as any[], maxRev };
  });
  const truncated = result.rows.length > MAX_RAW_QUERY_ROWS;
  const safeRows = result.rows.slice(0, MAX_RAW_QUERY_ROWS).map((row: any) => normalizeRow(row));
  return { rows: safeRows, durationMs: Date.now() - t0, truncated, maxRev: result.maxRev };
}

async function runRawQuery(
  sql: any,
  opts: RunRawQueryOpts,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number; truncated: boolean }> {
  const t0 = Date.now();
  const params = Array.isArray(opts.params) ? opts.params : [];
  // Wrap in a transaction so:
  //   1. SET LOCAL TRANSACTION READ ONLY rejects any UPDATE/INSERT/DDL the
  //      user pastes (or that lives inside a CTE or subquery).
  //   2. SET LOCAL statement_timeout is scoped to this tx only.
  // Both SET LOCAL targets cannot be parameterized — but the only "user input"
  // that flows into them is the timeout, which is a numeric literal we own.
  const rows: any[] = await sql.transaction(async (tx: any) => {
    await tx.unsafe(`set local transaction read only`);
    await tx.unsafe(`set local statement_timeout = ${RAW_QUERY_STATEMENT_TIMEOUT_MS}`);
    return tx.unsafe(opts.sql, params);
  });
  const truncated = rows.length > MAX_RAW_QUERY_ROWS;
  const safeRows = rows.slice(0, MAX_RAW_QUERY_ROWS).map((row: any) => normalizeRow(row));
  return { rows: safeRows, durationMs: Date.now() - t0, truncated };
}

async function refreshV4MaterializedViews(
  sql: any,
): Promise<{ name: string; ok: boolean; error?: string }[]> {
  // CONCURRENTLY needs the unique index migration 0017 created. Run them in
  // parallel — Postgres serialises the actual refresh internally per-view but
  // network round-trips overlap, which keeps the tick latency budget tight.
  const settled = await Promise.allSettled(
    V4_MATERIALIZED_VIEWS.map((name) => sql.unsafe(`refresh materialized view concurrently ${name}`)),
  );
  return settled.map((r, i) => {
    const name = V4_MATERIALIZED_VIEWS[i]!;
    if (r.status === "fulfilled") return { name, ok: true };
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return { name, ok: false, error };
  });
}

async function refreshGroupAggregates(sql: any) {
  await sql`refresh materialized view v3_group_aggregates`;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
  return out;
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (typeof v === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) obj[k] = normalizeValue(val);
    return obj;
  }
  return v;
}
