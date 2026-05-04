// Ingest hook — пишет render_items для свежевставленных normalized events.
//
// Используется из:
//   • handleAgentAppend (sync-engine.ts) — при поступлении новых событий
//   • backfill script — для имеющихся 599k normalized event'ов
//
// Контракт: вызвать ОДИН РАЗ после INSERT INTO agent_normalized_events,
// передав идентификаторы только что вставленных строк + их normalized + raw.
// Функция инсертит render rows в одной транзакции (или в той же что снаружи,
// если sql — это уже tx).
//
// Идемпотентность: ON CONFLICT (source_event_id, part_index) DO UPDATE.
// Это значит: можно безопасно перезапускать backfill, или вызывать на
// событии которое было обновлено (sync_revision поменялся).

import { eventToRenderRows, type EventLike, type RenderRow } from "./render";

export type IngestedEventContext = {
  /** id из agent_normalized_events */
  eventId: number;
  /** sync_revision назначенный при insert/update */
  syncRevision: number;
  /** source_file_id */
  sourceFileId: number;
  /** source_generation */
  sourceGeneration: number;
  /** agent_id */
  agentId: string;
  /** provider */
  provider: string;
  /** projectKey из source_files.metadata->>'projectKey' (может быть null) */
  projectKey: string | null;
  /** the normalized field */
  normalized: unknown;
  /** raw legacy payload (если есть) */
  raw?: unknown;
  /** event role/type (used by render fallbacks) */
  role?: string | null;
  eventType?: string | null;
};

/**
 * Записывает render_items для одного события.
 * sql может быть transaction-handle или верхним sql template.
 */
export async function writeRenderItemsForEvent(sql: any, ctx: IngestedEventContext): Promise<number> {
  const rows = computeRenderRows(ctx);
  if (rows.length === 0) return 0;
  await bulkInsertRenderRows(sql, ctx, rows);
  return rows.length;
}

export function computeRenderRows(ctx: IngestedEventContext): RenderRow[] {
  const event: EventLike = {
    id: ctx.eventId,
    role: ctx.role,
    eventType: ctx.eventType,
    normalized: ctx.normalized,
    raw: ctx.raw,
  };
  return eventToRenderRows(event);
}

async function bulkInsertRenderRows(sql: any, ctx: IngestedEventContext, rows: RenderRow[]) {
  // Сначала удаляем старые render rows для этого события (на случай переписи sync_revision).
  // Это держит инвариант: render rows всегда отражают текущую normalized версию.
  await sql`
    delete from agent_render_items
    where source_event_id = ${ctx.eventId}
  `;

  // Bulk insert. Postgres ограничивает 65k параметров, render row = 13 параметров,
  // на одно событие максимум ~10 рядов → запас 5000×, безопасно.
  for (const row of rows) {
    await sql`
      insert into agent_render_items (
        source_event_id, part_index,
        source_file_id, source_generation,
        agent_id, provider, project_key,
        kind, role, display,
        payload, payload_bytes, tool_id,
        sync_revision
      )
      values (
        ${row.source_event_id}, ${row.part_index},
        ${ctx.sourceFileId}, ${ctx.sourceGeneration},
        ${ctx.agentId}, ${ctx.provider}, ${ctx.projectKey},
        ${row.kind}, ${row.role}, ${row.display},
        ${row.payload}::jsonb, ${row.payload_bytes}, ${row.tool_id},
        ${ctx.syncRevision}
      )
      on conflict (source_event_id, part_index) do update set
        source_file_id = excluded.source_file_id,
        source_generation = excluded.source_generation,
        agent_id = excluded.agent_id,
        provider = excluded.provider,
        project_key = excluded.project_key,
        kind = excluded.kind,
        role = excluded.role,
        display = excluded.display,
        payload = excluded.payload,
        payload_bytes = excluded.payload_bytes,
        tool_id = excluded.tool_id,
        sync_revision = excluded.sync_revision
    `;
  }
}

/**
 * Вспомогательная функция: вытаскивает project_key из metadata источника.
 * Зеркалит логику apps/backend/v2-read-model.ts.inferProjectKey, упрощённо.
 */
export function projectKeyFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const candidates = [m.projectKey, m.project, m.projectName];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}
