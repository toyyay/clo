import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { missingInventoryFilesFromCursors, scanInventory } from "./inventory";

describe("agent-v2 inventory", () => {
  test("scans configured roots and applies ignore patterns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-inventory-"));
    const claudeRoot = join(dir, "claude");
    const projectDir = join(claudeRoot, "project-a");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(claudeRoot, "node_modules"), { recursive: true });
    await writeFile(join(projectDir, "session-1.jsonl"), "{\"type\":\"message\"}\n");
    await writeFile(join(projectDir, "notes.txt"), "ignore me\n");
    await writeFile(join(claudeRoot, "node_modules", "hidden.jsonl"), "{}\n");

    const files = await scanInventory([{ provider: "claude", rootPath: claudeRoot }], ["node_modules"]);

    expect(files).toHaveLength(1);
    expect(files[0].provider).toBe("claude");
    expect(files[0].relativePath).toBe("project-a/session-1.jsonl");
    expect(files[0].projectKey).toBe("project-a");
    expect(files[0].sessionId).toBe("session-1");
  });

  test("builds tombstones for legacy Claude cursor roots outside the active scan", () => {
    const missingPath = "/Users/example/Downloads/claude/projects/project-a/session-1.jsonl";
    const files = missingInventoryFilesFromCursors(
      {
        [missingPath]: {
          generation: 1,
          offset: 10,
          lineNo: 1,
          sizeBytes: 10,
          mtimeMs: 1000,
        },
      },
      [{ provider: "claude", rootPath: "/Users/example/.claude/projects" }],
      [],
    );

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      provider: "claude",
      sourcePath: missingPath,
      relativePath: "project-a/session-1.jsonl",
      logicalId: "claude:project-a/session-1.jsonl",
      projectKey: "project-a",
      sessionId: "session-1",
    });
  });
});
