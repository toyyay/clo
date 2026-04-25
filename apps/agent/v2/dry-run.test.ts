import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runAgentV2DryRun } from "./dry-run";

describe("agent-v2 dry-run", () => {
  test("uses explicit temp roots and only persists state when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-dry-run-"));
    const rootPath = join(dir, "codex");
    const statePath = join(dir, "state", "v2.json");
    await mkdir(join(rootPath, "nested"), { recursive: true });
    await writeFile(join(rootPath, "nested", "session.jsonl"), "{\"hello\":\"world\"}\n");

    const first = await runAgentV2DryRun({
      roots: [{ provider: "codex", rootPath }],
      statePath,
      persistState: false,
    });

    expect(first.fileCount).toBe(1);
    expect(first.pendingRecordCount).toBe(1);
    expect(await readFile(statePath, "utf8").catch(() => "")).toBe("");

    const second = await runAgentV2DryRun({
      roots: [{ provider: "codex", rootPath }],
      statePath,
      persistState: true,
    });

    expect(second.plannedChunkCount).toBe(1);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.cursors).toEqual({});
    expect(state.previewCursors[join(rootPath, "nested", "session.jsonl")]).toBeTruthy();
  });
});
