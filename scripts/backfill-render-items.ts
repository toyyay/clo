#!/usr/bin/env bun
// Backfill agent_render_items from existing agent_normalized_events.
//
// Usage:
//   DATABASE_URL=postgres://... bun run scripts/backfill-render-items.ts [--batch=2000] [--max=N] [--from=ID] [--dry-run]
//
// Properties:
//   • Idempotent — пишет ON CONFLICT, можно перезапускать.
//   • Resumeable — выводит "next id" в stdout, можно пропускать через --from=ID.
//   • Безопасно прерывать — каждый батч в своей транзакции.

import { sql } from "../apps/backend/db";
import { writeRenderItemsForEvent, projectKeyFromMetadata } from "../apps/backend/sync-v3/ingest-hook";

type Args = { batch: number; max: number; from: number; dryRun: boolean };

function parseArgs(): Args {
  const args: Args = { batch: 2000, max: Infinity, from: 0, dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--batch=")) args.batch = Math.max(1, Number(a.split("=")[1] ?? "2000"));
    else if (a.startsWith("--max=")) args.max = Math.max(1, Number(a.split("=")[1] ?? "Infinity"));
    else if (a.startsWith("--from=")) args.from = Math.max(0, Number(a.split("=")[1] ?? "0"));
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

async function run() {
  const args = parseArgs();
  console.log(`backfill render_items: batch=${args.batch} from=${args.from} dryRun=${args.dryRun}`);

  // Получим примерный объём работы.
  const [{ count: totalCount }] = await sql`
    select count(*)::bigint as count from agent_normalized_events where id >= ${args.from}
  `;
  console.log(`pending events: ~${totalCount}`);

  let lastId = args.from - 1;
  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  const startedAt = Date.now();

  while (processed < args.max) {
    const remaining = Math.min(args.batch, args.max - processed);
    const rows = await sql`
      select
        e.id,
        e.sync_revision,
        e.source_file_id,
        e.source_generation,
        e.agent_id,
        e.provider,
        e.event_type,
        e.role,
        e.normalized,
        f.metadata as file_metadata
      from agent_normalized_events e
      join agent_source_files f on f.id = e.source_file_id
      where e.id > ${lastId}
      order by e.id asc
      limit ${remaining}
    `;
    if (rows.length === 0) break;

    if (args.dryRun) {
      lastId = Number(rows[rows.length - 1].id);
      processed += rows.length;
      console.log(`(dry) processed=${processed} lastId=${lastId}`);
      continue;
    }

    await sql.transaction(async (tx: any) => {
      for (const row of rows) {
        const written = await writeRenderItemsForEvent(tx, {
          eventId: Number(row.id),
          syncRevision: Number(row.sync_revision ?? row.id),
          sourceFileId: Number(row.source_file_id),
          sourceGeneration: Number(row.source_generation ?? 1),
          agentId: String(row.agent_id),
          provider: String(row.provider ?? "unknown"),
          projectKey: projectKeyFromMetadata(row.file_metadata),
          normalized: row.normalized,
          raw: undefined, // legacy raw doesn't live here; render covers normalized path
          role: row.role ?? null,
          eventType: row.event_type ?? null,
        });
        inserted += written;
        if (written === 0) skipped += 1;
      }
    });

    lastId = Number(rows[rows.length - 1].id);
    processed += rows.length;
    const elapsedMs = Date.now() - startedAt;
    const rate = (processed / Math.max(1, elapsedMs / 1000)).toFixed(0);
    console.log(`processed=${processed} inserted=${inserted} skipped=${skipped} lastId=${lastId} rate=${rate}/s`);
  }

  console.log(`\ndone. processed=${processed} inserted=${inserted} skipped=${skipped} lastId=${lastId}`);
  console.log(`resume with --from=${lastId + 1}`);
  await sql.end({ timeout: 5 });
}

run().catch((error) => {
  console.error("backfill failed:", error);
  process.exit(1);
});
