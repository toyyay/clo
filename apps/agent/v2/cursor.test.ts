import { appendFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { readAppendJsonl } from "./cursor";
import type { InventoryFile } from "./types";

describe("agent-v2 append_jsonl cursor", () => {
  test("reads only complete appended lines and resumes from cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-cursor-"));
    const sourcePath = join(dir, "session.jsonl");
    await writeFile(sourcePath, "{\"n\":1}\n{\"n\":2}");
    const file = await inventoryFile(sourcePath);

    const first = await readAppendJsonl(file, undefined, { readChunkBytes: 1024 });
    expect(first.records.map((record) => record.rawLine)).toEqual(["{\"n\":1}"]);

    await appendFile(sourcePath, "\n{\"n\":3}\n");
    const updatedFile = await inventoryFile(sourcePath);
    const second = await readAppendJsonl(updatedFile, first.nextCursor, { readChunkBytes: 1024 });

    expect(second.records.map((record) => record.rawLine)).toEqual(["{\"n\":2}", "{\"n\":3}"]);
    expect(second.nextCursor.lineNo).toBe(3);
    expect(second.nextCursor.tailSha256).toHaveLength(64);
  });

  test("reads through a long line until a newline appears beyond the first window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-cursor-long-"));
    const sourcePath = join(dir, "session.jsonl");
    await writeFile(sourcePath, `${"x".repeat(32)}\n`);
    const file = await inventoryFile(sourcePath);

    const batch = await readAppendJsonl(file, undefined, { readChunkBytes: 8 });

    expect(batch.records).toHaveLength(1);
    expect(batch.records[0].rawLine).toBe("x".repeat(32));
    expect(batch.nextCursor.offset).toBe(33);
  });

  test("resets generation when the previous tail hash no longer matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-cursor-rewrite-"));
    const sourcePath = join(dir, "session.jsonl");
    await writeFile(sourcePath, "{\"n\":1}\n");
    const file = await inventoryFile(sourcePath);
    const first = await readAppendJsonl(file, undefined, { readChunkBytes: 1024 });

    await writeFile(sourcePath, "{\"n\":9}\n{\"n\":10}\n");
    const rewrittenFile = await inventoryFile(sourcePath);
    const second = await readAppendJsonl(rewrittenFile, first.nextCursor, { readChunkBytes: 1024 });

    expect(second.reset).toBe(true);
    expect(second.nextCursor.generation).toBe(2);
    expect(second.records.map((record) => record.rawLine)).toEqual(["{\"n\":9}", "{\"n\":10}"]);
  });
});

async function inventoryFile(sourcePath: string): Promise<InventoryFile> {
  const fileStat = await stat(sourcePath);
  return {
    provider: "claude",
    sourcePath,
    relativePath: "session.jsonl",
    sizeBytes: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    dev: fileStat.dev,
    ino: fileStat.ino,
    logicalId: "claude:session.jsonl",
    sessionId: "session",
  };
}
