import { createHash } from "node:crypto";
import { normalizeTranscriptRecord } from "../../../packages/parsers";
import type { AgentNormalizedEventInput } from "../../../packages/contracts";
import type { AgentV2Identity, UploadChunk } from "./types";

export type AgentV1AppendRequest = {
  agent: AgentV2Identity;
  files: Array<{
    provider: UploadChunk["provider"];
    sourcePath: string;
    relativePath?: string;
    logicalId: string;
    generation: number;
    pathSha256: string;
    sizeBytes: number;
    mtimeMs: number;
    metadata: {
      generation: number;
    };
  }>;
  source: {
    provider: UploadChunk["provider"];
    sourcePath: string;
    relativePath?: string;
    logicalId: string;
    generation: number;
    pathSha256: string;
    sizeBytes: number;
    mtimeMs: number;
    metadata: {
      generation: number;
    };
  };
  cursor: {
    scope: "append";
    value: string;
    metadata: {
      generation: number;
      startOffset: number;
      endOffset: number;
      startLine: number;
      endLine: number;
    };
  };
  chunks: Array<{
    chunkId: string;
    generation: number;
    cursorStart: string;
    cursorEnd: string;
    rawSha256: string;
    rawBytes: number;
    rawText: string;
    encoding: "utf8";
    contentType: "application/x-ndjson";
    metadata: {
      generation: number;
    };
    events: AgentNormalizedEventInput[];
  }>;
};

export function buildAgentV1AppendRequest(agent: AgentV2Identity, chunk: UploadChunk): AgentV1AppendRequest {
  const generation = chunk.generation ?? 1;
  const source = {
    provider: chunk.provider,
    sourcePath: chunk.logicalId,
    relativePath: chunk.relativePath,
    logicalId: chunk.logicalId,
    generation,
    pathSha256: sha256Hex(chunk.sourcePath),
    sizeBytes: chunk.sizeBytes ?? chunk.endOffset,
    mtimeMs: chunk.mtimeMs ?? 0,
    metadata: {
      generation,
    },
  };

  const rawText = chunk.rawText;
  const rawBytes = Buffer.byteLength(rawText, "utf8");

  return {
    agent,
    files: [source],
    source,
    cursor: {
      scope: "append",
      value: String(chunk.endOffset),
      metadata: {
        generation,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      },
    },
    chunks: [
      {
        chunkId: chunk.chunkId,
        generation,
        cursorStart: String(chunk.startOffset),
        cursorEnd: String(chunk.endOffset),
        rawSha256: sha256Hex(rawText),
        rawBytes,
        rawText,
        encoding: "utf8",
        contentType: "application/x-ndjson",
        metadata: {
          generation,
        },
        events: chunk.records.map((record) => normalizeRecord(chunk, record)),
      },
    ],
  };
}

function normalizeRecord(chunk: UploadChunk, record: UploadChunk["records"][number]) {
  const generation = chunk.generation ?? 1;
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
    eventUid: `${chunk.logicalId}:g${generation}:${record.lineNo}:${record.offset}`,
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
