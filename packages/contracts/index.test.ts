import { describe, expect, test } from "bun:test";
import { buildSyncPolicy } from "../../apps/backend/sync-engine";
import { buildAgentV1AppendRequest } from "../../apps/agent/v2/upload";
import type { AgentV2Identity, UploadChunk } from "../../apps/agent/v2/types";
import {
  AGENT_V1_ENDPOINTS,
  CHAT_SYNC_PROTOCOL,
  type AgentAppendResponse,
  type AgentHelloRequest,
  type AgentHelloResponse,
  type AgentInventoryRequest,
  type AgentInventoryResponse,
  type NormalizedChat,
  type ServerSyncPolicy,
  validateAgentAppendRequest,
  validateAgentAppendResponse,
  validateAgentHelloRequest,
  validateAgentHelloResponse,
  validateAgentInventoryRequest,
  validateAgentInventoryResponse,
  validateNormalizedChat,
  validateServerSyncPolicy,
} from "./index";

const now = "2026-04-25T10:00:00.000Z";
const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const shaC = "c".repeat(64);
const shaD = "d".repeat(64);

const agent: AgentV2Identity = {
  agentId: "agent-test",
  hostname: "workstation",
  platform: "darwin",
  arch: "arm64",
  version: "test",
};

describe("agent v1 sync contracts", () => {
  test("validates the production hello request and response envelope", () => {
    const request: AgentHelloRequest = {
      agent,
      capabilities: {
        inventory: true,
        appendJsonlCursors: true,
        chunkedUploads: true,
        providers: ["claude", "codex", "gemini"],
      },
    };
    const policy = buildSyncPolicy() as unknown as ServerSyncPolicy;
    const response: AgentHelloResponse = {
      ok: true,
      protocol: CHAT_SYNC_PROTOCOL,
      serverTime: now,
      agentId: agent.agentId,
      policy,
    };

    expect(AGENT_V1_ENDPOINTS.hello).toBe("/api/agent/v1/hello");
    expect(validateAgentHelloRequest(request)).toEqual({ ok: true, value: request });
    expect(validateAgentHelloResponse(response)).toEqual({ ok: true, value: response });
    expect(validateAgentHelloRequest({ ...request, agent: { hostname: "missing-id" } })).toEqual({
      ok: false,
      error: "agent.agentId: expected non-empty string",
    });
    expect(validateAgentHelloResponse({ ...response, protocol: "v2" })).toEqual({
      ok: false,
      error: "helloResponse.protocol: expected agent-v1",
    });
  });

  test("validates backend sync policy as returned by buildSyncPolicy", () => {
    const policy = buildSyncPolicy() as unknown as ServerSyncPolicy;

    expect(validateServerSyncPolicy(policy)).toEqual({ ok: true, value: policy });
    expect(policy.protocol).toBe(CHAT_SYNC_PROTOCOL);
    expect(policy.maxUploadChunkBytes).toBe(policy.requestLimits.rawChunkBytes);
    expect(policy.providers).toContain("path");

    expect(
      validateServerSyncPolicy({
        ...policy,
        requestLimits: { ...policy.requestLimits, rawChunkBytes: 0 },
      }),
    ).toEqual({
      ok: false,
      error: "policy.requestLimits.rawChunkBytes: expected positive integer",
    });
  });

  test("validates inventory request and ack shapes accepted by the backend", () => {
    const policy = buildSyncPolicy() as unknown as ServerSyncPolicy;
    const request: AgentInventoryRequest = {
      agent,
      cursor: {
        scope: "inventory",
        value: "2048",
        metadata: {
          generation: 3,
          offset: 2048,
          lineNo: 24,
          tailSha256: shaA,
        },
      },
      files: [
        {
          provider: "claude",
          sourcePath: "/Users/example/.claude/projects/session.jsonl",
          relativePath: "projects/session.jsonl",
          logicalId: "claude:projects/session.jsonl",
          sourceKind: "conversation",
          pathSha256: shaB,
          sizeBytes: 2048,
          mtimeMs: 1_776_000_000_000,
          contentSha256: shaC,
          encoding: "utf8",
          metadata: {
            cursor: {
              generation: 3,
              offset: 2048,
              lineNo: 24,
            },
          },
        },
      ],
    };
    const response: AgentInventoryResponse = {
      ok: true,
      acceptedFiles: 1,
      deletedFiles: 0,
      fileIds: ["1"],
      policy,
    };

    expect(validateAgentInventoryRequest(request)).toEqual({ ok: true, value: request });
    expect(validateAgentInventoryResponse(response)).toEqual({ ok: true, value: response });
    expect(
      validateAgentInventoryRequest({
        ...request,
        cursor: {
          ...request.cursor,
          metadata: { ...request.cursor?.metadata, generation: -1 },
        },
      }),
    ).toEqual({
      ok: false,
      error: "inventory.cursor.metadata.generation: expected positive integer",
    });
  });

  test("validates append uploads built by the agent v2 adapter and backend append acks", () => {
    const chunk: UploadChunk = {
      chunkId: "chunk-1",
      generation: 1,
      provider: "codex",
      sourcePath: "/Users/example/.codex/sessions/2026/04/25/session.jsonl",
      relativePath: "2026/04/25/session.jsonl",
      logicalId: "codex:2026/04/25/session.jsonl",
      sizeBytes: 16,
      mtimeMs: 1,
      startOffset: 0,
      endOffset: 16,
      startLine: 1,
      endLine: 1,
      byteLength: 16,
      rawText: "{\"type\":\"user\"}\n",
      records: [{ lineNo: 1, offset: 0, byteLength: 16, rawLine: "{\"type\":\"user\"}" }],
    };
    const request = buildAgentV1AppendRequest(agent, chunk);
    const requestWithGeneration = {
      ...request,
      cursor: {
        ...request.cursor,
        metadata: {
          ...request.cursor.metadata,
          generation: 2,
          offset: chunk.startOffset,
          lineNo: chunk.startLine - 1,
          tailSha256: shaD,
        },
      },
    };
    const response: AgentAppendResponse = {
      ok: true,
      sourceFileId: "1",
      acceptedChunks: 1,
      acceptedEvents: 1,
      cursor: "16",
      storage: {
        rawChunks: "hash_only",
        rawFilesStoredByDefault: false,
      },
    };

    expect(validateAgentAppendRequest(request)).toEqual({ ok: true, value: request });
    expect(validateAgentAppendRequest(requestWithGeneration)).toEqual({ ok: true, value: requestWithGeneration });
    expect(validateAgentAppendResponse(response)).toEqual({ ok: true, value: response });
    expect(
      validateAgentAppendRequest({
        ...request,
        chunks: [{ ...request.chunks[0], cursorStart: "not-an-offset" }],
      }),
    ).toEqual({
      ok: false,
      error: "append.chunks[0].cursorStart: expected cursor offset string",
    });
  });

  test("validates normalized chats with generation cursors and source metadata", () => {
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
          sizeBytes: 1024,
          tailSha256: shaA,
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
    expect(validateNormalizedChat({ ...chat, sessions: [{ ...chat.sessions?.[0], provider: "Bad Provider" }] })).toEqual({
      ok: false,
      error: "chat.sessions[0].provider: expected provider identifier",
    });
  });
});
