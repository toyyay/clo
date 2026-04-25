import { describe, expect, test } from "bun:test";
import { planUploadChunks } from "./planner";
import type { InventoryFile, SyncPolicy, TailBatch } from "./types";

const file: InventoryFile = {
  provider: "codex",
  sourcePath: "/tmp/session.jsonl",
  relativePath: "session.jsonl",
  sizeBytes: 100,
  mtimeMs: 1,
  logicalId: "codex:session.jsonl",
};

const policy: SyncPolicy = {
  enabled: true,
  uploadsEnabled: true,
  maxFileBytes: 1000,
  maxUploadChunkBytes: 8,
  maxUploadLines: 10,
  scanRoots: ["codex"],
  ignorePatterns: [],
  source: "default",
};

describe("agent-v2 upload planner", () => {
  test("skips oversized single records instead of creating rejected chunks", () => {
    const batch: TailBatch = {
      file,
      records: [{ lineNo: 1, offset: 0, byteLength: 20, rawLine: "x".repeat(19) }],
      rawStartOffset: 0,
      rawBytes: new TextEncoder().encode(`${"x".repeat(19)}\n`),
      nextCursor: { generation: 1, offset: 20, lineNo: 1, sizeBytes: 20, mtimeMs: 1 },
      truncated: false,
      reset: false,
    };

    const plan = planUploadChunks([file], [batch], policy);

    expect(plan.chunks).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain("exceeds maxUploadChunkBytes");
  });

  test("uses contiguous span length for chunks with blank lines between records", () => {
    const batch: TailBatch = {
      file,
      records: [
        { lineNo: 1, offset: 0, byteLength: 2, rawLine: "a" },
        { lineNo: 3, offset: 3, byteLength: 2, rawLine: "b" },
      ],
      rawStartOffset: 0,
      rawBytes: new TextEncoder().encode("a\n\nb\n"),
      nextCursor: { generation: 1, offset: 5, lineNo: 3, sizeBytes: 5, mtimeMs: 1 },
      truncated: false,
      reset: false,
    };

    const plan = planUploadChunks([file], [batch], { ...policy, maxUploadChunkBytes: 10 });

    expect(plan.chunks[0].startOffset).toBe(0);
    expect(plan.chunks[0].endOffset).toBe(5);
    expect(plan.chunks[0].byteLength).toBe(5);
    expect(plan.chunks[0].rawText).toBe("a\n\nb\n");
  });

  test("splits chunks by contiguous raw span, including blank lines between records", () => {
    const rawText = "a\n\n\n\n\n\n\n\n\nb\n";
    const batch: TailBatch = {
      file,
      records: [
        { lineNo: 1, offset: 0, byteLength: 2, rawLine: "a" },
        { lineNo: 10, offset: 10, byteLength: 2, rawLine: "b" },
      ],
      rawStartOffset: 0,
      rawBytes: new TextEncoder().encode(rawText),
      nextCursor: { generation: 1, offset: 12, lineNo: 10, sizeBytes: 12, mtimeMs: 1 },
      truncated: false,
      reset: false,
    };

    const plan = planUploadChunks([file], [batch], policy);

    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks.map((chunk) => chunk.rawText)).toEqual(["a\n", "b\n"]);
    expect(plan.chunks.every((chunk) => Buffer.byteLength(chunk.rawText) <= policy.maxUploadChunkBytes)).toBe(true);
  });

  test("includes cursor generation in planned chunks and stable chunk ids", () => {
    const records = [{ lineNo: 1, offset: 0, byteLength: 2, rawLine: "a" }];
    const first = planUploadChunks(
      [file],
      [{
        file,
        records,
        rawStartOffset: 0,
        rawBytes: new TextEncoder().encode("a\n"),
        nextCursor: { generation: 1, offset: 2, lineNo: 1, sizeBytes: 2, mtimeMs: 1 },
        truncated: false,
        reset: false,
      }],
      policy,
    );
    const rewrite = planUploadChunks(
      [file],
      [{
        file,
        records,
        rawStartOffset: 0,
        rawBytes: new TextEncoder().encode("a\n"),
        nextCursor: { generation: 2, offset: 2, lineNo: 1, sizeBytes: 2, mtimeMs: 1 },
        truncated: false,
        reset: true,
      }],
      policy,
    );

    expect(first.chunks[0].generation).toBe(1);
    expect(rewrite.chunks[0].generation).toBe(2);
    expect(rewrite.chunks[0].chunkId).not.toBe(first.chunks[0].chunkId);
  });
});
