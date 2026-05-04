// View predicate -> Postgres WHERE fragment (parameterized).
//
// Принимает Predicate, возвращает { sql, params } для подставы в более крупный
// запрос:
//
//     select ... from agent_render_items r
//     join agent_source_files f on f.id = r.source_file_id
//     where r.display = true and (${resolved.sql})
//
// Использует $-placeholder синтаксис (Postgres native), потому что у нас Bun's
// `SQL`-tagged template — но мы строим параметрический фрагмент руками для
// flexibility (template tag не умеет переменное число условий).
//
// Возвращаемые placeholders нумеруются от $start; у вызывающего:
//
//     const r = resolvePredicate(view.predicate, 1);
//     await sql.unsafe(`select ... where ${r.sql}`, r.params);

import type { Predicate } from "../../../packages/sync-v3/contracts";

export type ResolvedPredicate = {
  /** SQL fragment using $1, $2 ... starting at offset given to resolvePredicate */
  sql: string;
  /** Bind params in order matching the placeholders. */
  params: unknown[];
};

export function resolvePredicate(pred: Predicate, startOffset = 1): ResolvedPredicate {
  const params: unknown[] = [];
  const ctx: BuildCtx = { params, nextIndex: () => startOffset + params.length };
  const sql = buildPredicate(pred, ctx);
  return { sql, params };
}

type BuildCtx = {
  params: unknown[];
  nextIndex(): number;
};

function buildPredicate(pred: Predicate, ctx: BuildCtx): string {
  if ("all" in pred) {
    if (pred.all.length === 0) return "TRUE";
    return "(" + pred.all.map((p) => buildPredicate(p, ctx)).join(" AND ") + ")";
  }
  if ("any" in pred) {
    if (pred.any.length === 0) return "FALSE";
    return "(" + pred.any.map((p) => buildPredicate(p, ctx)).join(" OR ") + ")";
  }
  if ("not" in pred) {
    return "NOT (" + buildPredicate(pred.not, ctx) + ")";
  }
  if ("host" in pred) {
    const i = ctx.nextIndex();
    ctx.params.push(pred.host);
    // host can match by agent.id OR agent.hostname (UI-friendly).
    const j = ctx.nextIndex();
    ctx.params.push(pred.host);
    return `(r.agent_id = $${i} OR f.agent_id IN (SELECT id FROM agents WHERE hostname = $${j}))`;
  }
  if ("project" in pred) {
    const i = ctx.nextIndex();
    ctx.params.push(pred.project);
    return `(r.project_key = $${i})`;
  }
  if ("provider" in pred) {
    const i = ctx.nextIndex();
    ctx.params.push(pred.provider);
    return `(r.provider = $${i})`;
  }
  if ("sessionId" in pred) {
    // sessionId is the v3-style id "v3:<source_file_id>" — extract the numeric part.
    const numeric = parseV3SessionId(pred.sessionId);
    if (numeric === null) return "FALSE"; // unknown id format → match nothing
    const i = ctx.nextIndex();
    ctx.params.push(numeric);
    return `(r.source_file_id = $${i})`;
  }
  if ("lastSeenWithin" in pred) {
    const i = ctx.nextIndex();
    ctx.params.push(pred.lastSeenWithin.days);
    return `(f.last_seen_at >= now() - ($${i}::int * interval '1 day'))`;
  }
  return "FALSE";
}

export function parseV3SessionId(id: string): number | null {
  if (id.startsWith("v3:")) {
    const n = Number(id.slice(3));
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d+$/.test(id)) return Number(id);
  return null;
}

/** Конвертит numeric source_file_id обратно в "v3:N" формат для UI. */
export function v3SessionIdFromSourceFileId(sourceFileId: number | string | bigint): string {
  return `v3:${sourceFileId}`;
}
