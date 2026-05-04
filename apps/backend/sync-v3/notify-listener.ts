// v4 sync: render-change listener.
//
// Two responsibilities, kept in one module so the debounce window is shared:
//
//   1. Detect "something changed in agent_render_items" — the trigger from
//      migration 0017 emits pg_notify('chatview_render_changed', {...}) on
//      every insert/update. Bun's SQL client doesn't yet expose LISTEN/NOTIFY
//      delivery (see node_modules/bun-types/docs/runtime/sql.mdx — "We
//      haven't implemented LISTEN/NOTIFY support"), so we can't subscribe
//      directly. The pragmatic fallback used here:
//
//        a) The HTTP ingest path calls reportRenderChange() in-process the
//           moment a render row is appended — that's the fast path, latency
//           is single-digit ms, and it carries the exact source_file_id.
//        b) A 1s poll over `coalesce(max(sync_revision), 0)` catches anything
//           the ingest path missed (manual SQL inserts, backfill scripts,
//           future ingest paths that forget to call us). Polling is cheap —
//           it's a single index lookup against a btree on sync_revision.
//
//      When Bun grows native LISTEN delivery we can drop the polling loop
//      and keep the rest of this module unchanged.
//
//   2. Debounce notifications into a single tick + materialized-view refresh.
//      Both happen on the same 200 ms cadence; tick fires first, MV refresh
//      runs in the background so a slow `refresh materialized view` can't
//      starve the WS broadcast.

import type { WsHandlers } from "./ws-server";
import type { Repo } from "./repo";

const DEBOUNCE_MS = 200;
const FILES_LIMIT = 64;
/** Poll fallback cadence — 1s is a fine compromise: caught-up clients still
 *  see DB changes within a second even when the in-process notify path is
 *  bypassed. Keep this >= debounce so we don't pile up overlapping batches. */
const POLL_INTERVAL_MS = 1000;

export type NotifyListener = {
  /** Called by ingest path when a render row was just written. Cheap — only
   *  marks dirty + (re)arms the debounce timer. */
  reportRenderChange(sourceFileId: number, syncRevision: number): void;
  /** Stop the poll loop. Tests mostly. */
  stop(): void;
};

export type NotifyListenerCtx = {
  repo: Repo;
  handlers: Pick<WsHandlers, "broadcastTick">;
  log?: (level: "debug" | "info" | "warn" | "error", event: string, ctx?: unknown) => void;
  /** Override for tests — defaults to globalThis.setInterval. */
  setInterval?: typeof setInterval;
  /** Override for tests — defaults to globalThis.clearInterval. */
  clearInterval?: typeof clearInterval;
  /** Override for tests — defaults to globalThis.setTimeout. */
  setTimeout?: typeof setTimeout;
};

export function makeNotifyListener(ctx: NotifyListenerCtx): NotifyListener {
  const log = ctx.log ?? ((level, event, _ctx) => {
    if (level === "warn" || level === "error") console.warn(`[sync-v4 notify] ${event}`, _ctx ?? "");
  });
  const setIv = ctx.setInterval ?? setInterval;
  const clearIv = ctx.clearInterval ?? clearInterval;
  const setTo = ctx.setTimeout ?? setTimeout;

  // Pending batch state. We coalesce notifies in a 200ms window then fire one
  // tick + one MV refresh.
  let pendingFiles = new Set<number>();
  let pendingMaxRev = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSeenMaxRev = 0;

  function arm() {
    if (timer !== null) return;
    timer = setTo(flush, DEBOUNCE_MS);
  }

  function flush() {
    timer = null;
    if (pendingMaxRev === 0 && pendingFiles.size === 0) return;
    const files = pendingFiles;
    const maxRev = pendingMaxRev;
    pendingFiles = new Set();
    pendingMaxRev = 0;
    lastSeenMaxRev = Math.max(lastSeenMaxRev, maxRev);

    // Broadcast first — this is the latency-critical path. MV refresh follows
    // and may take hundreds of ms on a busy DB; clients shouldn't wait for it.
    const fileList = files.size > FILES_LIMIT ? undefined : Array.from(files).sort((a, b) => a - b);
    try {
      ctx.handlers.broadcastTick(maxRev, fileList);
    } catch (err) {
      log("warn", "broadcast.failed", err);
    }

    // Background MV refresh. Failures are warn-logged but never thrown — a
    // slow MV must not block the next tick.
    void ctx.repo
      .refreshV4MaterializedViews()
      .then((results) => {
        for (const r of results) {
          if (!r.ok) log("warn", "mv.refresh.failed", { name: r.name, error: r.error });
        }
      })
      .catch((err) => log("warn", "mv.refresh.threw", err));
  }

  function reportRenderChange(sourceFileId: number, syncRevision: number) {
    if (Number.isFinite(sourceFileId) && sourceFileId > 0) pendingFiles.add(sourceFileId);
    if (Number.isFinite(syncRevision) && syncRevision > pendingMaxRev) pendingMaxRev = syncRevision;
    arm();
  }

  // Polling fallback — defends against external writers (backfill, manual
  // SQL, future ingest paths). Each poll asks "did max(sync_revision) move?"
  // and if so emits a tick with no `files` (we don't know which ones moved).
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Backoff — on repeated SQL errors we slow the poll instead of crash-looping.
  let pollBackoffMs = POLL_INTERVAL_MS;
  const POLL_BACKOFF_MAX_MS = 5000;

  async function poll() {
    try {
      const m = await ctx.repo.fetchMaxRev();
      pollBackoffMs = POLL_INTERVAL_MS; // success — reset backoff
      if (m > lastSeenMaxRev) {
        // External revision movement we didn't see via reportRenderChange.
        // Tick without a `files` hint — clients re-pull broadly.
        if (m > pendingMaxRev) pendingMaxRev = m;
        arm();
      }
    } catch (err) {
      log("warn", "poll.failed", err);
      // Exponential backoff capped at 5s. Reschedule via setTimeout once;
      // the regular interval keeps running underneath so we don't starve.
      pollBackoffMs = Math.min(POLL_BACKOFF_MAX_MS, Math.max(POLL_INTERVAL_MS, pollBackoffMs * 2));
    }
  }

  pollTimer = setIv(() => void poll(), POLL_INTERVAL_MS);
  // Seed lastSeenMaxRev on startup so the first poll doesn't fire a spurious
  // tick for the entire pre-existing revision history.
  void ctx.repo
    .fetchMaxRev()
    .then((m) => {
      lastSeenMaxRev = m;
    })
    .catch((err) => log("warn", "seed.failed", err));

  return {
    reportRenderChange,
    stop() {
      if (pollTimer !== null) {
        clearIv(pollTimer);
        pollTimer = null;
      }
      if (timer !== null) {
        // Best-effort — flush is via setTimeout; clearTimeout works even if
        // we got a different timer impl, as long as types match.
        try { (clearTimeout as any)(timer); } catch {}
        timer = null;
      }
    },
  };
}
