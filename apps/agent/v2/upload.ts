import { createHash } from "node:crypto";
import { normalizeTranscriptRecord } from "../../../packages/parsers";
import type { AgentNormalizedEventInput } from "../../../packages/contracts";
import type { AgentV2Identity, InventoryFile, UploadChunk } from "./types";

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
      projectKey?: string;
      projectName?: string;
      sessionId?: string;
      title?: string;
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
      projectKey?: string;
      projectName?: string;
      sessionId?: string;
      title?: string;
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
    rawText?: string;
    encoding: "utf8";
    contentType: "application/x-ndjson";
    metadata: {
      generation: number;
    };
    events: AgentNormalizedEventInput[];
  }>;
};

export type AgentV1InventoryRequest = {
  agent: AgentV2Identity;
  files: Array<{
    provider: InventoryFile["provider"];
    sourcePath: string;
    relativePath: string;
    logicalId: string;
    pathSha256: string;
    sizeBytes: number;
    mtimeMs: number;
    metadata: {
      projectKey?: string;
      projectName?: string;
      sessionId?: string;
    };
    deleted?: boolean;
  }>;
  cursor: {
    scope: "inventory";
    value: string;
    metadata: {
      activeFiles: number;
      deletedFiles: number;
    };
  };
};

export function buildAgentV1AppendRequest(agent: AgentV2Identity, chunk: UploadChunk): AgentV1AppendRequest {
  const generation = chunk.generation ?? 1;
  const sourceMetadata = sourceMetadataForChunk(chunk, generation);
  const source = {
    provider: chunk.provider,
    sourcePath: chunk.logicalId,
    relativePath: chunk.relativePath,
    logicalId: chunk.logicalId,
    generation,
    pathSha256: sha256Hex(chunk.sourcePath),
    sizeBytes: chunk.sizeBytes ?? chunk.endOffset,
    mtimeMs: chunk.mtimeMs ?? 0,
    metadata: sourceMetadata,
  };

  const rawText = chunk.rawText;
  const rawBytes = chunk.omitRawText ? chunk.rawBytes ?? chunk.byteLength : Buffer.byteLength(rawText, "utf8");
  const rawSha256 = chunk.omitRawText ? chunk.rawSha256 ?? sha256Hex(rawText) : sha256Hex(rawText);

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
        rawSha256,
        rawBytes,
        ...(!chunk.omitRawText ? { rawText } : {}),
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

export function buildAgentV1InventoryRequest(
  agent: AgentV2Identity,
  activeFiles: InventoryFile[],
  deletedFiles: InventoryFile[] = [],
): AgentV1InventoryRequest {
  const active = activeFiles.map((file) => inventorySourceFile(file, false));
  const deleted = deletedFiles.map((file) => inventorySourceFile(file, true));
  return {
    agent,
    files: [...active, ...deleted],
    cursor: {
      scope: "inventory",
      value: String(Date.now()),
      metadata: {
        activeFiles: active.length,
        deletedFiles: deleted.length,
      },
    },
  };
}

function sourceMetadataForChunk(chunk: UploadChunk, generation: number) {
  const metadata: AgentV1AppendRequest["source"]["metadata"] = { generation };
  if (chunk.sessionId) metadata.sessionId = chunk.sessionId;
  if (chunk.projectKey) {
    metadata.projectKey = chunk.projectKey;
    metadata.projectName = shortProject(chunk.projectKey);
  }

  for (const record of chunk.records) {
    const parsed = parseRecordObject(record.rawLine);
    const payload = objectValue(parsed?.payload);
    if (!parsed || !payload) continue;
    const type = stringValue(parsed.type);
    const payloadType = stringValue(payload.type);

    if (type === "session_meta") {
      const cwd = stringValue(payload.cwd) ?? stringValue(objectValue(payload.git)?.repo_root) ?? stringValue(objectValue(payload.git)?.repoRoot);
      const sessionId = stringValue(payload.id) ?? stringValue(payload.thread_id) ?? stringValue(payload.threadId);
      if (cwd) {
        metadata.projectKey = codexProjectKey(cwd);
        metadata.projectName = basenameFromPath(cwd);
      }
      if (sessionId) metadata.sessionId = sessionId;
    }

    const title = stringValue(payload.thread_name) ?? stringValue(payload.title);
    if (title && (payloadType === "thread_name_updated" || !metadata.title)) metadata.title = title;
  }

  return metadata;
}

function inventorySourceFile(file: InventoryFile, deleted: boolean) {
  const metadata: AgentV1InventoryRequest["files"][number]["metadata"] = {};
  if (file.projectKey) {
    metadata.projectKey = file.projectKey;
    metadata.projectName = shortProject(file.projectKey);
  }
  if (file.sessionId) metadata.sessionId = file.sessionId;

  return {
    provider: file.provider,
    sourcePath: file.logicalId,
    relativePath: file.relativePath,
    logicalId: file.logicalId,
    pathSha256: sha256Hex(file.sourcePath),
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    metadata,
    ...(deleted ? { deleted: true } : {}),
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

function parseRecordObject(rawLine: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(rawLine);
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function codexProjectKey(cwd: string) {
  return cwd.replace(/[\\/]+/g, "-").replace(/^-?/, "-");
}

function basenameFromPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function shortProject(raw: string) {
  return raw.replace(/^-Users-[^-]+-/, "").replace(/^p-?/, (match) => (match === "p" ? "p" : "")) || raw;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
