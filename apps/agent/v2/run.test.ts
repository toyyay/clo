import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseAgentV2RunArgs, scanAndUploadAgentV2 } from "./run";

describe("agent-v2 live runner", () => {
  test("uploads planned chunks to the agent append endpoint and advances cursors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-run-"));
    const rootPath = join(dir, "codex");
    const sourcePath = join(rootPath, "nested", "session.jsonl");
    const statePath = join(dir, "state", "v2.json");
    const line = "{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n";
    await mkdir(join(rootPath, "nested"), { recursive: true });
    await writeFile(sourcePath, line);

    const seenUrls: string[] = [];
    const uploads: unknown[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrls.push(String(url));
      if (String(url).endsWith("/api/agent/v1/hello")) {
        return jsonResponse({
          policy: {
            enabled: true,
            uploadsEnabled: true,
            maxFileBytes: 1024 * 1024,
            maxUploadChunkBytes: 1024,
            maxUploadLines: 10,
            scanRoots: ["codex"],
            ignorePatterns: [],
          },
        });
      }
      if (String(url).endsWith("/api/agent/v1/append")) {
        uploads.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ok: true, cursor: "43" });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const summary = await scanAndUploadAgentV2({
      roots: [{ provider: "codex", rootPath }],
      statePath,
      backendUrl: "http://backend.test",
      token: "test-token",
      readChunkBytes: 1024,
      fetchImpl,
    });

    expect(summary.uploadedChunkCount).toBe(1);
    expect(seenUrls).toEqual(["http://backend.test/api/agent/v1/hello", "http://backend.test/api/agent/v1/append"]);
    expect(uploads).toHaveLength(1);
    expect((uploads[0] as any).files[0].relativePath).toBe("nested/session.jsonl");
    expect((uploads[0] as any).chunks[0].generation).toBe(1);
    expect((uploads[0] as any).chunks[0].cursorStart).toBe("0");
    expect((uploads[0] as any).chunks[0].rawText).toBe(line);
    expect((uploads[0] as any).chunks[0].events[0].eventUid).toContain(":g1:");

    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.cursors[sourcePath].offset).toBe(Buffer.byteLength(line));

    const second = await scanAndUploadAgentV2({
      roots: [{ provider: "codex", rootPath }],
      statePath,
      backendUrl: "http://backend.test",
      token: "test-token",
      readChunkBytes: 1024,
      fetchImpl,
    });
    expect(second.uploadedChunkCount).toBe(0);
  });

  test("does not advance the cursor when all pending records are skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-run-skip-"));
    const rootPath = join(dir, "codex");
    const sourcePath = join(rootPath, "session.jsonl");
    const statePath = join(dir, "state", "v2.json");
    await mkdir(rootPath, { recursive: true });
    await writeFile(sourcePath, `${"x".repeat(64)}\n`);

    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/api/agent/v1/hello")) {
        return jsonResponse({
          policy: {
            enabled: true,
            uploadsEnabled: true,
            maxFileBytes: 1024 * 1024,
            maxUploadChunkBytes: 8,
            maxUploadLines: 10,
            scanRoots: ["codex"],
            ignorePatterns: [],
          },
        });
      }
      return jsonResponse({ ok: true }, 200);
    }) as unknown as typeof fetch;

    const summary = await scanAndUploadAgentV2({
      roots: [{ provider: "codex", rootPath }],
      statePath,
      backendUrl: "http://backend.test",
      token: "test-token",
      readChunkBytes: 1024,
      fetchImpl,
    });

    expect(summary.uploadedChunkCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.cursors[sourcePath]).toBeUndefined();
  });

  test("parses repeated roots and env roots for watch or one-shot commands", () => {
    const options = parseAgentV2RunArgs(
      ["--root", "claude=/tmp/claude", "--root=codex=/tmp/codex", "--once", "--log-idle-every-scans", "0"],
      { BACKEND_URL: "http://backend.test", AGENT_TOKEN: "token" },
    );
    expect(options.once).toBe(true);
    expect(options.logIdleEveryScans).toBe(0);
    expect(options.roots).toEqual([
      { provider: "claude", rootPath: "/tmp/claude" },
      { provider: "codex", rootPath: "/tmp/codex" },
    ]);

    const envOptions = parseAgentV2RunArgs([], {
      BACKEND_URL: "http://backend.test",
      AGENT_TOKEN: "token",
      ROOTS: "gemini=/tmp/gemini",
    });
    expect(envOptions.roots).toEqual([{ provider: "gemini", rootPath: "/tmp/gemini" }]);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
