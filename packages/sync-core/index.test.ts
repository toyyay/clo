import { describe, expect, test } from "bun:test";
import {
  decideSync,
  evaluatePolicy,
  matchesPolicyPath,
  planAppendChunk,
  sha256Hex,
  type FileStatSnapshot,
  type SyncCursor,
} from "./index";

const stat = (size: number, extra: Partial<FileStatSnapshot> = {}): FileStatSnapshot => ({
  size,
  mtimeMs: 1000,
  ctimeMs: 1000,
  ...extra,
});

const cursor = (extra: Partial<SyncCursor> = {}): SyncCursor => ({
  generation: 3,
  size: 8,
  offset: 8,
  lineNo: 2,
  tailSha256: sha256Hex("a\nb\n"),
  mtimeMs: 900,
  ctimeMs: 900,
  ...extra,
});

describe("sync-core policy matching", () => {
  test("matches recursive home, extension, and cache policy paths", () => {
    expect(
      matchesPolicyPath("/Users/toy/.codex/sessions/project/run.jsonl", "~/.codex/sessions/**/*.jsonl", {
        homeDir: "/Users/toy",
      }),
    ).toBe(true);
    expect(matchesPolicyPath("/tmp/app/state.sqlite", "**/*.sqlite")).toBe(true);
    expect(matchesPolicyPath("/tmp/app/Cache/index.db", "**/Cache/**")).toBe(true);
    expect(matchesPolicyPath("/tmp/app/cache/index.db", "**/Cache/**")).toBe(false);
  });

  test("evaluates ignore, noise, and rate-limit hints with later rules overriding", () => {
    const decision = evaluatePolicy(
      "/Users/toy/.codex/sessions/p/run.jsonl",
      [
        { pattern: "**/*.jsonl", action: "noise", rateLimitMs: 2000, maxRecords: 50 },
        { pattern: "~/.codex/sessions/**/*.jsonl", action: "sync", mode: "append", maxBytes: 1024 },
      ],
      { homeDir: "/Users/toy" },
    );

    expect(decision).toMatchObject({
      action: "sync",
      ignored: false,
      noise: false,
      mode: "append",
      rateLimitMs: 2000,
      maxBytes: 1024,
      maxRecords: 50,
    });

    expect(evaluatePolicy("/tmp/a/Cache/file", [{ pattern: "**/Cache/**", action: "ignore" }]).ignored).toBe(true);
  });
});

describe("sync-core decisions", () => {
  test("continues append when size advances and tail hash still matches", () => {
    const prior = cursor({ offset: 4, size: 4, lineNo: 2, inode: 10, dev: 1 });
    const decision = decideSync(prior, stat(8, { inode: 10, dev: 1 }), sha256Hex("a\nb\n"));

    expect(decision).toMatchObject({
      kind: "append",
      reason: "append",
      generation: 3,
      startOffset: 4,
      startLineNo: 2,
    });
  });

  test("starts a new generation when a file is truncated or rotated", () => {
    expect(decideSync(cursor({ offset: 10, inode: 10, dev: 1 }), stat(4, { inode: 10, dev: 1 }))).toMatchObject({
      kind: "snapshot",
      reason: "truncated",
      generation: 4,
      startOffset: 0,
      startLineNo: 0,
    });

    expect(decideSync(cursor({ inode: 10, dev: 1 }), stat(8, { inode: 11, dev: 1 }), sha256Hex("a\nb\n"))).toMatchObject({
      kind: "snapshot",
      reason: "rotated",
      generation: 4,
      startOffset: 0,
      startLineNo: 0,
    });
  });

  test("starts a rewrite generation on tail hash mismatch", () => {
    const decision = decideSync(cursor({ offset: 4, size: 4 }), stat(8), sha256Hex("x\nb\n"));

    expect(decision).toMatchObject({
      kind: "snapshot",
      reason: "tail-mismatch",
      generation: 4,
      startOffset: 0,
      startLineNo: 0,
    });
  });
});

describe("sync-core append chunk planner", () => {
  test("emits only complete newline-terminated records", () => {
    const plan = planAppendChunk("one\ntwo", cursor({ generation: 1, offset: 0, lineNo: 0, tailSha256: undefined }), stat(7));

    expect(plan.records.map((record) => record.text)).toEqual(["one"]);
    expect(plan.emittedByteLength).toBe(4);
    expect(plan.pendingByteLength).toBe(3);
    expect(plan.nextCursorCandidate).toMatchObject({
      generation: 1,
      offset: 4,
      lineNo: 1,
      size: 7,
    });
    expect(plan.nextCursorCandidate?.tailSha256).toBe(sha256Hex("one\n"));
  });

  test("chunks large appends by record and byte limits", () => {
    const byRecord = planAppendChunk("a\nb\nc\nd\n", cursor({ generation: 1, offset: 0, lineNo: 0 }), stat(8), {
      maxRecords: 2,
    });

    expect(byRecord.records.map((record) => [record.offset, record.lineNo, record.text])).toEqual([
      [0, 1, "a"],
      [2, 2, "b"],
    ]);
    expect(byRecord.emittedByteLength).toBe(4);
    expect(byRecord.pendingByteLength).toBe(4);
    expect(byRecord.limitedBy).toBe("maxRecords");
    expect(byRecord.nextCursorCandidate?.offset).toBe(4);

    const byBytes = planAppendChunk("aa\nbb\ncc\n", cursor({ generation: 1, offset: 0, lineNo: 0 }), stat(9), {
      maxBytes: 4,
    });

    expect(byBytes.records.map((record) => record.text)).toEqual(["aa"]);
    expect(byBytes.emittedByteLength).toBe(3);
    expect(byBytes.pendingByteLength).toBe(6);
    expect(byBytes.limitedBy).toBe("maxBytes");
  });

  test("uses previous tail bytes when advancing a small chunk", () => {
    const plan = planAppendChunk("c\n", cursor({ generation: 2, offset: 4, lineNo: 2 }), stat(6), {
      previousTailBytes: "a\nb\n",
      tailBytes: 6,
    });

    expect(plan.nextCursorCandidate?.offset).toBe(6);
    expect(plan.nextCursorCandidate?.lineNo).toBe(3);
    expect(plan.nextCursorCandidate?.tailSha256).toBe(sha256Hex("a\nb\nc\n"));
  });

  test("does not emit an oversized first record past maxBytes", () => {
    const plan = planAppendChunk("abcdef\nnext\n", cursor({ generation: 1, offset: 0, lineNo: 0 }), stat(12), {
      maxBytes: 4,
    });

    expect(plan.records).toHaveLength(0);
    expect(plan.emittedByteLength).toBe(0);
    expect(plan.pendingByteLength).toBe(12);
    expect(plan.limitedBy).toBe("maxBytes");
    expect(plan.nextCursorCandidate).toBeUndefined();
  });
});

describe("sync-core sha256", () => {
  test("hashes synthetic byte strings", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
