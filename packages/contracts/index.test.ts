import { describe, expect, test } from "bun:test";
import {
  CHAT_SYNC_CONTRACT_VERSION,
  type AgentHelloRequest,
  type AppendChunkAck,
  type AppendChunkUpload,
  type InventoryReport,
  type NormalizedChat,
  type ServerSyncPolicy,
  validateAgentHelloRequest,
  validateAppendChunkAck,
  validateAppendChunkUpload,
  validateInventoryReport,
  validateNormalizedChat,
  validateServerSyncPolicy,
} from "./index";

const now = "2026-04-25T10:00:00.000Z";

const policy: ServerSyncPolicy = {
  revision: "rev-1",
  maxChunkBytes: 64 * 1024,
  maxInventoryFiles: 10_000,
  heartbeatIntervalMs: 30_000,
  uploadConcurrency: 2,
  allowProviders: ["claude", "codex", "gemini"],
  requireTailHash: true,
  watchRules: [
    {
      id: "claude-jsonl",
      kind: "append_jsonl",
      provider: "claude",
      path: "~/Library/Application Support/Claude/projects/**/*.jsonl",
      lineFormat: "jsonl",
    },
    {
      id: "codex-log",
      kind: "append_log",
      provider: "codex",
      path: "~/.codex/**/*.log",
      encoding: "utf8",
    },
    {
      id: "gemini-snapshot",
      kind: "snapshot_file",
      provider: "gemini",
      path: "~/.gemini/history.json",
      contentKind: "json",
    },
    {
      id: "sqlite-history",
      kind: "sqlite_reader",
      provider: "unknown",
      path: "~/Library/Application Support/example/history.sqlite",
      query: "select * from messages where id > ? order by id",
      cursorColumn: "id",
    },
    {
      id: "ignore-cache",
      kind: "ignore",
      path: "**/Cache/**",
      reason: "cache noise",
    },
  ],
  redaction: {
    enabled: true,
    patterns: ["api-key", "token"],
  },
};

describe("chat sync contracts", () => {
  test("validates agent hello requests", () => {
    const request: AgentHelloRequest = {
      contractVersion: CHAT_SYNC_CONTRACT_VERSION,
      sentAt: now,
      agent: {
        installId: "install-a",
        hostname: "dev-laptop",
        platform: "darwin",
        arch: "arm64",
        version: "0.1.0",
        labels: {
          owner: "synthetic",
        },
      },
      capabilities: {
        providers: ["claude", "codex", "gemini"],
        watchKinds: ["append_jsonl", "append_log", "snapshot_file", "sqlite_reader", "ignore"],
        supportsAppendChunks: true,
        supportsSnapshots: true,
        supportsSqlite: true,
        maxChunkBytes: 64 * 1024,
      },
    };

    expect(validateAgentHelloRequest(request)).toEqual({ ok: true, value: request });
    expect(validateAgentHelloRequest({ ...request, contractVersion: 999 })).toEqual({
      ok: false,
      error: "hello.contractVersion: expected 1",
    });
  });

  test("validates server sync policy and watch rules", () => {
    expect(validateServerSyncPolicy(policy)).toEqual({ ok: true, value: policy });

    const invalid = {
      ...policy,
      watchRules: [{ id: "bad-sqlite", kind: "sqlite_reader", path: "/tmp/history.db" }],
    };

    expect(validateServerSyncPolicy(invalid)).toEqual({
      ok: false,
      error: "policy.watchRules[0].query: expected non-empty string",
    });
  });

  test("validates inventory reports", () => {
    const report: InventoryReport = {
      agentId: "agent-a",
      reportedAt: now,
      files: [
        {
          provider: "claude",
          sourcePath: "/Users/example/.claude/projects/session.jsonl",
          fileId: "claude:session",
          ruleId: "claude-jsonl",
          ruleKind: "append_jsonl",
          sizeBytes: 2048,
          mtimeMs: 1_776_000_000_000,
          generation: 3,
          cursor: {
            generation: 3,
            offset: 2048,
            lineNo: 24,
            tailHash: "tail-a",
          },
          contentSha256: "sha256-a",
          tailHash: "tail-a",
        },
      ],
      summary: {
        totalFiles: 1,
        totalBytes: 2048,
        ignoredFiles: 0,
      },
    };

    expect(validateInventoryReport(report)).toEqual({ ok: true, value: report });
    expect(validateInventoryReport({ ...report, reportedAt: "not-a-date" })).toEqual({
      ok: false,
      error: "inventory.reportedAt: expected parseable date-time string",
    });
  });

  test("validates append chunk upload and ack cursors", () => {
    const upload: AppendChunkUpload = {
      agentId: "agent-a",
      provider: "codex",
      sourcePath: "/Users/example/.codex/history.log",
      fileId: "codex:history",
      cursor: {
        generation: 2,
        offset: 128,
        lineNo: 4,
        tailHash: "previous-tail",
      },
      chunk: {
        encoding: "utf8",
        text: "{\"type\":\"message\"}\n",
        byteLength: 19,
        lineCount: 1,
        sha256: "chunk-sha",
        tailHash: "new-tail",
      },
      observedAt: now,
    };

    const ack: AppendChunkAck = {
      ok: true,
      fileId: "codex:history",
      cursor: upload.cursor,
      acceptedBytes: 19,
      acceptedLines: 1,
      nextCursor: {
        generation: 2,
        offset: 147,
        lineNo: 5,
        tailHash: "new-tail",
      },
    };

    expect(validateAppendChunkUpload(upload)).toEqual({ ok: true, value: upload });
    expect(validateAppendChunkAck(ack)).toEqual({ ok: true, value: ack });
    expect(validateAppendChunkUpload({ ...upload, cursor: { generation: 2, offset: -1 } })).toEqual({
      ok: false,
      error: "appendChunk.cursor.offset: expected non-negative integer",
    });
  });

  test("validates normalized chats with source metadata and redaction summary", () => {
    const chat: NormalizedChat = {
      id: "chat-a",
      provider: "gemini",
      title: "Synthetic chat",
      createdAt: now,
      updatedAt: now,
      source: {
        provider: "gemini",
        sourcePath: "/Users/example/.gemini/history.json",
        fileId: "gemini:history",
        cursor: {
          generation: 1,
          offset: 512,
          lineNo: 0,
          tailHash: "tail-gemini",
        },
        rawKind: "conversation",
        redaction: {
          applied: true,
          rules: ["token"],
          counts: {
            token: 2,
          },
        },
      },
      sessions: [
        {
          id: "session-a",
          chatId: "chat-a",
          provider: "gemini",
          startedAt: now,
          source: {
            provider: "gemini",
            sourcePath: "/Users/example/.gemini/history.json",
            fileId: "gemini:history",
            rawKind: "session",
          },
          events: [
            {
              id: "event-a",
              sessionId: "session-a",
              provider: "gemini",
              kind: "message",
              role: "user",
              text: "hello",
              createdAt: now,
              source: {
                provider: "gemini",
                sourcePath: "/Users/example/.gemini/history.json",
                fileId: "gemini:history",
                rawKind: "message",
              },
            },
          ],
        },
      ],
    };

    expect(validateNormalizedChat(chat)).toEqual({ ok: true, value: chat });
    expect(validateNormalizedChat({ ...chat, sessions: [{ ...chat.sessions?.[0], provider: "other" }] })).toEqual({
      ok: false,
      error: "chat.sessions[0].provider: expected supported provider",
    });
  });
});
