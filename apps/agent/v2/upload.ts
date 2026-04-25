import { createHash } from "node:crypto";
import { normalizeTranscriptRecord } from "../../../packages/parsers";
import type { AgentV2Identity, UploadChunk } from "./types";

export type AgentV1AppendRequest = {
  agent: AgentV2Identity;
  source: {
    provider: UploadChunk["provider"];
    sourcePath: string;
    relativePath?: string;
    logicalId: string;
    pathSha256: string;
    sizeBytes: number;
  };
  cursor: {
    scope: "append";
    value: string;
    metadata: {
      startOffset: number;
      endOffset: number;
      startLine: number;
      endLine: number;
    };
  };
  chunks: Array<{
    chunkId: string;
    cursorStart: string;
    cursorEnd: string;
    rawSha256: string;
    rawBytes: number;
    encoding: "utf8";
    contentType: "application/x-ndjson";
    events: unknown[];
  }>;
};

export function buildAgentV1AppendRequest(agent: AgentV2Identity, chunk: UploadChunk): AgentV1AppendRequest {
  return {
    agent,
    source: {
      provider: chunk.provider,
      sourcePath: chunk.logicalId,
      relativePath: chunk.relativePath,
      logicalId: chunk.logicalId,
      pathSha256: sha256Hex(chunk.sourcePath),
      sizeBytes: chunk.endOffset,
    },
    cursor: {
      scope: "append",
      value: String(chunk.startOffset),
      metadata: {
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      },
    },
    chunks: [
      {
        chunkId: chunk.chunkId,
        cursorStart: String(chunk.startOffset),
        cursorEnd: String(chunk.endOffset),
        rawSha256: sha256Hex(chunk.records.map((record) => record.rawLine).join("\n") + "\n"),
        rawBytes: chunk.byteLength,
        encoding: "utf8",
        contentType: "application/x-ndjson",
        events: chunk.records.map((record) => normalizeRecord(chunk, record)),
      },
    ],
  };
}

function normalizeRecord(chunk: UploadChunk, record: UploadChunk["records"][number]) {
  let parsed: unknown = record.rawLine;
  try {
    parsed = JSON.parse(record.rawLine);
  } catch {
    // Keep invalid JSONL lines as parser diagnostics-style events without throwing away the chunk.
  }

  const event = normalizeTranscriptRecord(parsed, {
    provider: chunk.provider,
    sourcePath: chunk.logicalId,
    lineNo: record.lineNo,
    byteOffset: record.offset,
  });

  return {
    eventUid: `${chunk.logicalId}:${record.lineNo}:${record.offset}`,
    kind: event.kind,
    role: event.role,
    occurredAt: event.timestamp,
    sourceLineNo: record.lineNo,
    sourceOffset: record.offset,
    normalized: event,
  };
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
