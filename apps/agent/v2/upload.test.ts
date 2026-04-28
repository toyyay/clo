import { describe, expect, test } from "bun:test";
import { validateAppendPayload, validateInventoryPayload } from "../../backend/sync-engine";
import { buildAgentV1AppendRequest, buildAgentV1InventoryRequest } from "./upload";
import type { AgentV2Identity, UploadChunk } from "./types";

const agent: AgentV2Identity = {
  agentId: "agent-test",
  hostname: "workstation",
  platform: "darwin",
  arch: "arm64",
  version: "test",
  runtimeId: "runtime-test",
  pid: 123,
  startedAt: "2026-04-25T10:00:00.000Z",
};

describe("agent-v2 upload adapter", () => {
  test("builds a backend-valid append envelope from a planned chunk", () => {
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
      sessionId: "session",
    };

    const request = buildAgentV1AppendRequest(agent, chunk);
    const validated = validateAppendPayload(request);

    expect(request.source.sourcePath).toBe("codex:2026/04/25/session.jsonl");
    expect(request.files[0].metadata.generation).toBe(1);
    expect(request.files[0].metadata.sessionId).toBe("session");
    expect(request.chunks[0].rawText).toBe("{\"type\":\"user\"}\n");
    expect(request.chunks[0].rawBytes).toBe(16);
    expect(validated.source.sourcePath).toBe("2026/04/25/session.jsonl");
    expect(validated.source.sourceGeneration).toBe(1);
    expect(validated.chunks[0].cursorEnd).toBe("16");
    expect(validated.chunks[0].sourceGeneration).toBe(1);
    expect(validated.chunks[0].rawBytes).toBe(16);
    expect(validated.chunks[0].events[0].eventUid).toBe("codex:2026/04/25/session.jsonl:g1:1:0");
    expect(validated.chunks[0].events[0].sourceLineNo).toBe(1);
  });

  test("extracts Codex project metadata from session_meta payloads", () => {
    const rawLine = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "thread-1",
        cwd: "/Users/example/p/chatview",
      },
    });
    const chunk: UploadChunk = {
      chunkId: "chunk-1",
      generation: 1,
      provider: "codex",
      sourcePath: "/Users/example/.codex/sessions/2026/04/25/session.jsonl",
      relativePath: "2026/04/25/session.jsonl",
      logicalId: "codex:2026/04/25/session.jsonl",
      sizeBytes: rawLine.length + 1,
      mtimeMs: 1,
      startOffset: 0,
      endOffset: rawLine.length + 1,
      startLine: 1,
      endLine: 1,
      byteLength: rawLine.length + 1,
      rawText: `${rawLine}\n`,
      records: [{ lineNo: 1, offset: 0, byteLength: rawLine.length + 1, rawLine }],
    };

    const request = buildAgentV1AppendRequest(agent, chunk);

    expect(request.source.metadata).toMatchObject({
      generation: 1,
      projectKey: "-Users-example-p-chatview",
      projectName: "chatview",
      sessionId: "thread-1",
    });
  });

  test("builds backend-valid diagnostic events for omitted oversized records", () => {
    const chunk: UploadChunk = {
      chunkId: "chunk-oversized",
      generation: 1,
      provider: "codex",
      sourcePath: "/Users/example/.codex/sessions/session.jsonl",
      relativePath: "session.jsonl",
      logicalId: "codex:session.jsonl",
      sizeBytes: 65,
      mtimeMs: 1,
      startOffset: 0,
      endOffset: 65,
      startLine: 1,
      endLine: 1,
      byteLength: 65,
      rawText: "",
      omitRawText: true,
      rawSha256: "a".repeat(64),
      rawBytes: 65,
      records: [],
      diagnostics: [
        {
          reason: "record_too_large",
          message: "JSONL record exceeds maxUploadChunkBytes (65 > 8)",
          lineNo: 1,
          offset: 0,
          byteLength: 65,
          maxBytes: 8,
          rawSha256: "a".repeat(64),
        },
      ],
    };

    const request = buildAgentV1AppendRequest(agent, chunk);
    const validated = validateAppendPayload(request);

    expect(request.chunks[0].rawText).toBeUndefined();
    expect(request.chunks[0].metadata.diagnosticCount).toBe(1);
    expect(request.chunks[0].events[0]).toMatchObject({
      eventType: "agent_diagnostic",
      kind: "error",
      role: "system",
      metadata: {
        diagnostic: true,
        reason: "record_too_large",
        rawBytes: 65,
        maxBytes: 8,
      },
    });
    expect(validated.chunks[0].events[0].eventType).toBe("agent_diagnostic");
    expect(validated.chunks[0].events[0].sourceOffset).toBe(0);
  });

  test("builds a backend-valid inventory envelope with tombstones", () => {
    const request = buildAgentV1InventoryRequest(
      agent,
      [
        {
          provider: "claude",
          sourcePath: "/Users/example/.claude/projects/project-a/live.jsonl",
          relativePath: "project-a/live.jsonl",
          logicalId: "claude:project-a/live.jsonl",
          sizeBytes: 42,
          mtimeMs: 1000,
          projectKey: "project-a",
          sessionId: "live",
        },
      ],
      [
        {
          provider: "claude",
          sourcePath: "/Users/example/.claude/projects/project-a/gone.jsonl",
          relativePath: "project-a/gone.jsonl",
          logicalId: "claude:project-a/gone.jsonl",
          sizeBytes: 10,
          mtimeMs: 500,
          projectKey: "project-a",
          sessionId: "gone",
        },
      ],
    );
    const validated = validateInventoryPayload(request);

    expect(request.files[0].metadata).toMatchObject({ projectKey: "project-a", projectName: "project-a", sessionId: "live" });
    expect(request.files[1].deleted).toBe(true);
    expect(validated.files[0].sourcePath).toBe("project-a/live.jsonl");
    expect(validated.files[1].sourcePath).toBe("project-a/gone.jsonl");
    expect(validated.files[1].deleted).toBe(true);
  });
});
