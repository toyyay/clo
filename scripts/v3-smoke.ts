#!/usr/bin/env bun
// One-shot smoke test for sync-v3 — calls repo.buildSnapshot directly
// against the live DB (no WS, no auth). Useful to verify migrations + render
// pipeline + view-resolver SQL all line up on real data.
//
// Usage on prod:
//   docker run --rm --network=clo_default \
//     -e DATABASE_URL=postgres://... \
//     -v /tmp/v3-smoke.ts:/app/scripts/v3-smoke.ts:ro \
//     ghcr.io/toyyay/clo:<sha> bun run scripts/v3-smoke.ts

import { sql } from "../apps/backend/db";
import { makeRepo } from "../apps/backend/sync-v3/repo";
import type { ViewSpec } from "../packages/sync-v3/contracts";

async function main() {
  const repo = makeRepo(sql);

  const view: ViewSpec = {
    id: "smoke-recent",
    predicate: { lastSeenWithin: { days: 30 } },
    history: { tailItems: 5 },
    liveTail: true,
  };

  console.log("=== buildSnapshot ===");
  const t0 = Date.now();
  const snap = await repo.buildSnapshot(view);
  const elapsed = Date.now() - t0;
  console.log(`elapsed: ${elapsed}ms`);
  console.log(`cursor: ${snap.cursor}`);
  console.log(`groups: ${snap.groups.length}`);
  console.log(`chats: ${snap.chats.length}`);
  console.log(`tails: ${Object.keys(snap.tails).length} chats with items`);
  console.log(`totals.items: ${snap.totals.items}`);

  console.log("\n=== Top 5 chats by lastSeenAt ===");
  for (const chat of snap.chats.slice(0, 5)) {
    const tail = snap.tails[chat.chatId] ?? [];
    const sample = tail[tail.length - 1];
    console.log(`  ${chat.chatId.padEnd(12)} ${chat.title.slice(0, 30).padEnd(30)} items=${chat.itemCount} tail=${tail.length}` + (sample ? ` lastSeq=${sample.seq} kind=${sample.item.k}` : ""));
  }

  console.log("\n=== Top 5 groups ===");
  for (const g of snap.groups.slice(0, 5)) {
    console.log(`  L${g.level} ${g.label.slice(0, 30).padEnd(30)} chats=${g.chatCount} bytes=${(g.approxBytes / 1024 / 1024).toFixed(1)}MB topChatIds=${g.topChatIds.length}`);
  }

  console.log("\n=== fetchDelta from cursor 0 ===");
  const t1 = Date.now();
  const delta = await repo.fetchDelta(view, 0, 1024 * 32);
  console.log(`elapsed: ${Date.now() - t1}ms, items: ${delta.items.length}, cursor: ${delta.cursor}, bytesRemaining: ${delta.bytesRemaining}, moreReady: ${delta.moreReady}`);

  console.log("\n=== resolveMatchingViews (no clients yet, expect 0) ===");
  const matches = await repo.resolveMatchingViews(snap.chats[0]?.chatId ? Number(snap.chats[0].chatId.slice(3)) : 1);
  console.log(`matching views: ${matches.length}`);

  if (snap.chats.length) {
    const chatId = snap.chats[0]!.chatId;
    const sourceFileId = Number(chatId.slice(3));
    console.log(`\n=== fetchHistoryRange(${chatId}, before: ${snap.cursor}, limit: 3) ===`);
    const range = await repo.fetchHistoryRange({ chatId, before: snap.cursor + 1, limit: 3 });
    console.log(`items: ${range.items.length}, hasOlder: ${range.hasOlder}, hasNewer: ${range.hasNewer}`);
    for (const entry of range.items) {
      console.log(`  seq=${entry.seq} kind=${entry.item.k}`);
    }
  }

  console.log("\n=== ✓ all smoke checks completed ===");
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("smoke FAILED:", err);
  process.exit(1);
});
