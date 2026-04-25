import { describe, expect, test } from "bun:test";
import {
  handleAgentInventory,
  isSyncEngineHttpError,
  planRawChunkStorage,
  redactMetadata,
  syncEnginePolicy,
  validateAppendPayload,
  validateHelloPayload,
  validateInventoryPayload,
} from "./sync-engine";

const agent = {
  agentId: "agent-test",
  hostname: "workstation",
  platform: "darwin",
  arch: "arm64",
  version: "0.1.0",
  sourceRoot: "/Users/example/.claude",
};

describe("sync engine helpers", () => {
  test("builds a hello policy without requiring raw storage", () => {
    const result = validateHelloPayload({ agent });
    expect(result.agent.agentId).toBe("agent-test");
    expect(result.policy.protocol).toBe("agent-v1");
    expect(result.policy.enabled).toBe(true);
    expect(result.policy.scanRoots).toContain("codex");
    expect(result.policy.maxUploadChunkBytes).toBe(syncEnginePolicy.requestLimits.rawChunkBytes);
    expect(result.policy.ignorePatterns).toContain("auth.json");
    expect(result.policy.storage.rawFilesStoredByDefault).toBe(false);
    expect(syncEnginePolicy.storage.rawChunks).toBe("hash_only");
  });

  test("validates inventory summaries and redacts metadata", () => {
    const result = validateInventoryPayload({
      agent,
      files: [
        {
          provider: "claude",
          sourcePath: "/Users/example/.claude/projects/foo/session.jsonl",
          sizeBytes: 123,
          metadata: {
            safe: "kept",
            accessToken: "secret-token-value",
          },
        },
      ],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].provider).toBe("claude");
    expect(result.files[0].sourcePath).toBe("session.jsonl");
    expect(result.files[0].metadata.safe).toBe("kept");
    expect(Object.keys(result.files[0].metadata)).toContain("redacted_key_94a2776e7bd6");
    expect(result.files[0].pathSha256).toHaveLength(64);
  });

  test("hashes append raw chunks and marks raw content as not stored", () => {
    const result = validateAppendPayload({
      agent,
      source: {
        provider: "codex",
        sourcePath: "/Users/example/.codex/sessions/a.jsonl",
      },
      chunks: [
        {
          chunkId: "chunk-1",
          rawText: '{"type":"message","token":"abc"}\n',
          events: [
            {
              eventUid: "event-1",
              eventType: "message",
              normalized: {
                text: "hello",
                authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
              },
            },
          ],
        },
      ],
    });

    expect(result.chunks[0].rawSha256).toHaveLength(64);
    expect(result.chunks[0].rawBytes).toBeGreaterThan(0);
    expect(result.chunks[0].sourceGeneration).toBe(1);
    expect(result.chunks[0].appendIdentity).toBe("g1:chunk-1");
    expect(result.chunks[0].redaction.storedRaw).toBe(false);
    expect(result.chunks[0].events[0].eventUid).toBe("event-1");
    expect(result.chunks[0].events[0].normalized.authorization).toBeUndefined();
    expect(result.chunks[0].events[0].contentSha256).toHaveLength(64);
  });

  test("keeps append chunk and event identities generation-aware", () => {
    const base = {
      agent,
      source: {
        provider: "codex",
        sourcePath: "/Users/example/.codex/sessions/a.jsonl",
      },
      cursor: {
        scope: "append",
        value: "0",
        metadata: {
          startOffset: 0,
          endOffset: 12,
        },
      },
      chunks: [
        {
          chunkId: "same-offsets",
          cursorStart: "0",
          cursorEnd: "12",
          events: [
            {
              sourceLineNo: 1,
              sourceOffset: 0,
              normalized: { kind: "message", role: "user" },
            },
          ],
        },
      ],
    };

    const generation2 = validateAppendPayload({
      ...base,
      source: { ...base.source, generation: 2 },
      cursor: { ...base.cursor, metadata: { ...base.cursor.metadata, generation: 2 } },
    });
    const generation3 = validateAppendPayload({
      ...base,
      source: { ...base.source, generation: 3 },
      cursor: { ...base.cursor, metadata: { ...base.cursor.metadata, generation: 3 } },
    });

    expect(generation2.source.sourceGeneration).toBe(2);
    expect(generation2.chunks[0].sourceGeneration).toBe(2);
    expect(generation2.chunks[0].appendIdentity).toBe("g2:same-offsets");
    expect(generation2.cursor?.metadata.generation).toBe(2);
    expect(generation2.cursor?.metadata.sourceGeneration).toBe(2);
    expect(generation2.chunks[0].events[0].eventUid).not.toBe(generation3.chunks[0].events[0].eventUid);

    const fromCursorValue = validateAppendPayload({
      ...base,
      cursor: { ...base.cursor, value: "2:0" },
      chunks: [{ ...base.chunks[0], cursorStart: "2:0", cursorEnd: "2:12" }],
    });
    expect(fromCursorValue.source.sourceGeneration).toBe(2);
    expect(fromCursorValue.chunks[0].appendIdentity).toBe("g2:same-offsets");
  });

  test("plans filesystem raw chunk storage without bytea/text database payloads", () => {
    const hash = "a".repeat(64);
    const hashOnly = planRawChunkStorage(
      {
        agentId: "agent/test",
        sourceFileId: 42,
        sourceGeneration: 2,
        chunkId: "chunk/1",
        rawSha256: hash,
        rawBytes: 12,
        hasRawPayload: true,
      },
      { DATA_DIR: "/var/lib/chatview" },
    );

    expect(hashOnly.kind).toBe("hash_only");
    expect(hashOnly.storageKey).toBeNull();
    expect(hashOnly.rawBody).toBeNull();
    expect(hashOnly.rawText).toBeNull();

    const filesystem = planRawChunkStorage(
      {
        agentId: "agent/test",
        sourceFileId: 42,
        sourceGeneration: 2,
        chunkId: "chunk/1",
        rawSha256: hash,
        rawBytes: 12,
        hasRawPayload: true,
      },
      { DATA_DIR: "/var/lib/chatview", SYNC_RAW_STORAGE: "filesystem" },
    );

    expect(filesystem.kind).toBe("filesystem");
    expect(filesystem.storageKey).toBe(`filesystem/sync/raw-chunks/agent-test/42/g2/aa/chunk-1-${hash}`);
    expect(filesystem.rawBody).toBeNull();
    expect(filesystem.rawText).toBeNull();
  });

  test("rejects oversized raw chunks", () => {
    expect(() =>
      validateAppendPayload({
        agent,
        source: {
          provider: "gemini",
          sourcePath: "/tmp/gemini.jsonl",
        },
        chunks: [
          {
            rawText: "x".repeat(syncEnginePolicy.requestLimits.rawChunkBytes + 1),
          },
        ],
      }),
    ).toThrow();
  });

  test("redacts secret-like metadata recursively", () => {
    const redacted = redactMetadata({
      nested: {
        apiKey: "sk-this-should-not-survive",
        text: "Bearer abcdefghijklmnopqrstuvwxyz",
      },
    });

    expect(redacted).toEqual({
      nested: {
        redacted_key_61ea4113f56b: "<redacted>",
        text: "Bearer <redacted>",
      },
    });
  });

  test("accepts parser-shaped normalized events without persisting raw fields", () => {
    const result = validateAppendPayload({
      agent,
      source: {
        provider: "codex",
        sourcePath: "/Users/example/.codex/sessions/a.jsonl",
        relativePath: "2026/04/25/a.jsonl",
      },
      chunks: [
        {
          chunkId: "chunk-2",
          cursorEnd: "42",
          events: [
            {
              kind: "thinking",
              role: "assistant",
              rawLine: "{\"secret\":\"sk-should-not-survive\"}",
              source: {
                lineNo: 7,
                byteOffset: 22,
                rawKind: "reasoning",
              },
              normalized: {
                kind: "thinking",
                role: "assistant",
                parts: [{ kind: "thinking", text: "safe summary" }],
                raw: { secret: "sk-should-not-survive" },
                source: { lineNo: 7, byteOffset: 22, rawKind: "reasoning" },
              },
            },
          ],
        },
      ],
    });

    const event = result.chunks[0].events[0];
    expect(result.source.sourcePath).toBe("2026/04/25/a.jsonl");
    expect(event.eventUid).toHaveLength(64);
    expect(event.eventType).toBe("thinking");
    expect(event.sourceLineNo).toBe(7);
    expect(event.sourceOffset).toBe(22);
    expect(event.normalized.raw).toBeUndefined();
    expect(event.normalized.parts).toEqual([{ kind: "thinking", text: "safe summary" }]);
  });

  test("scrubs null bytes from jsonb-bound normalized payloads", () => {
    const result = validateAppendPayload({
      agent,
      source: {
        provider: "codex",
        sourcePath: "/Users/example/.codex/sessions/nul.jsonl",
      },
      chunks: [
        {
          chunkId: "chunk-nul",
          events: [
            {
              eventUid: "event-nul",
              eventType: "message",
              role: "user",
              normalized: {
                kind: "message",
                role: "user",
                parts: [{ kind: "text", text: "before\u0000after" }],
                source: { rawKind: "message\u0000item" },
              },
            },
          ],
        },
      ],
    });

    const event = result.chunks[0].events[0];
    expect(event.normalized.parts).toEqual([{ kind: "text", text: "before<nul>after" }]);
    expect(event.normalized.source).toEqual({ rawKind: "message<nul>item" });
  });

  test("validation errors carry http status", () => {
    try {
      validateHelloPayload({ agent: {} });
    } catch (error) {
      expect(isSyncEngineHttpError(error)).toBe(true);
      if (isSyncEngineHttpError(error)) expect(error.status).toBe(400);
    }
  });

  test("active inventory reports clear prior deleted_at on source files", async () => {
    const { calls, sql } = recordingSql();
    const req = new Request("http://chatview.test/api/agent/v1/inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent,
        files: [
          {
            provider: "codex",
            sourcePath: "/Users/example/.codex/sessions/a.jsonl",
            sizeBytes: 1,
            deleted: false,
          },
        ],
      }),
    });

    await handleAgentInventory(req, sql);

    const sourceUpsert = calls.find((call) => call.text.includes("insert into agent_source_files"));
    expect(sourceUpsert?.text).toContain("deleted_at = excluded.deleted_at");
    expect(sourceUpsert?.values).toContain(false);
  });
});

function recordingSql() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.from(strings).join("?");
    calls.push({ text, values });
    if (text.includes("insert into agent_source_files")) return [{ id: 101 }];
    return [{ id: 1 }];
  }) as any;
  sql.transaction = async (fn: (tx: typeof sql) => Promise<void>) => fn(sql);
  return { calls, sql };
}
