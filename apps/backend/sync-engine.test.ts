import { describe, expect, test } from "bun:test";
import {
  isSyncEngineHttpError,
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
    expect(result.chunks[0].redaction.storedRaw).toBe(false);
    expect(result.chunks[0].events[0].eventUid).toBe("event-1");
    expect(result.chunks[0].events[0].normalized.authorization).toBeUndefined();
    expect(result.chunks[0].events[0].contentSha256).toHaveLength(64);
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

  test("validation errors carry http status", () => {
    try {
      validateHelloPayload({ agent: {} });
    } catch (error) {
      expect(isSyncEngineHttpError(error)).toBe(true);
      if (isSyncEngineHttpError(error)) expect(error.status).toBe(400);
    }
  });
});
