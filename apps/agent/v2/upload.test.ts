import { describe, expect, test } from "bun:test";
import { validateAppendPayload } from "../../backend/sync-engine";
import { buildAgentV1AppendRequest } from "./upload";
import type { AgentV2Identity, UploadChunk } from "./types";

const agent: AgentV2Identity = {
  agentId: "agent-test",
  hostname: "workstation",
  platform: "darwin",
  arch: "arm64",
  version: "test",
};

describe("agent-v2 upload adapter", () => {
  test("builds a backend-valid append envelope from a planned chunk", () => {
    const chunk: UploadChunk = {
      chunkId: "chunk-1",
      provider: "codex",
      sourcePath: "/Users/example/.codex/sessions/2026/04/25/session.jsonl",
      relativePath: "2026/04/25/session.jsonl",
      logicalId: "codex:2026/04/25/session.jsonl",
      startOffset: 0,
      endOffset: 18,
      startLine: 1,
      endLine: 1,
      byteLength: 18,
      records: [{ lineNo: 1, offset: 0, byteLength: 18, rawLine: "{\"type\":\"user\"}" }],
    };

    const request = buildAgentV1AppendRequest(agent, chunk);
    const validated = validateAppendPayload(request);

    expect(request.source.sourcePath).toBe("codex:2026/04/25/session.jsonl");
    expect(validated.source.sourcePath).toBe("2026/04/25/session.jsonl");
    expect(validated.chunks[0].cursorEnd).toBe("18");
    expect(validated.chunks[0].events[0].eventUid).toBe("codex:2026/04/25/session.jsonl:1:0");
    expect(validated.chunks[0].events[0].sourceLineNo).toBe(1);
  });
});
