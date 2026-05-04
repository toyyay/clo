// Chat-id helpers used across the v3/v4 server-side code paths.
//
// The v3 predicate-resolver (resolvePredicate / `Predicate` SQL fragment
// builder) lived in this file until the v4 cleanup. The frontend now writes
// its own WHERE clauses inside `query` payloads, so the resolver is gone.
// The two helpers below survive because both ingest and the WS server still
// translate between numeric `agent_source_files.id` and the public
// `v3:<id>` identifier surface.

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
