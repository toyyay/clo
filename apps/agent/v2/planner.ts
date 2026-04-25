import { createHash } from "node:crypto";
import type { InventoryFile, SyncPolicy, TailBatch, TailRecord, UploadChunk, UploadPlan, UploadTransport } from "./types";

export function planUploadChunks(files: InventoryFile[], batches: TailBatch[], policy: SyncPolicy): UploadPlan {
  const skipped: UploadPlan["skipped"] = [];
  const chunks: UploadChunk[] = [];
  const batchByPath = new Map(batches.map((batch) => [batch.file.sourcePath, batch]));

  for (const file of files) {
    if (!policy.scanRoots.includes(file.provider)) {
      skipped.push({ sourcePath: file.sourcePath, reason: `provider ${file.provider} disabled by policy` });
      continue;
    }
    if (file.sizeBytes > policy.maxFileBytes) {
      skipped.push({ sourcePath: file.sourcePath, reason: `file exceeds maxFileBytes (${policy.maxFileBytes})` });
      continue;
    }

    const batch = batchByPath.get(file.sourcePath);
    if (!batch?.records.length) continue;
    const chunked = chunkRecords(file, batch.records, policy, batch);
    chunks.push(...chunked.chunks);
    skipped.push(...chunked.skipped);
  }

  return { chunks, skipped };
}

export async function executeUploadPlan(plan: UploadPlan, transport: UploadTransport) {
  for (const chunk of plan.chunks) {
    await transport.uploadChunk(chunk);
  }
}

function chunkRecords(
  file: InventoryFile,
  records: TailRecord[],
  policy: SyncPolicy,
  batch: TailBatch,
): Pick<UploadPlan, "chunks" | "skipped"> {
  const chunks: UploadChunk[] = [];
  const skipped: UploadPlan["skipped"] = [];
  let pending: TailRecord[] = [];

  for (const record of records) {
    if (record.byteLength > policy.maxUploadChunkBytes) {
      if (pending.length) {
        chunks.push(toChunk(file, pending, batch));
        pending = [];
      }
      skipped.push({
        sourcePath: file.sourcePath,
        reason: `record at line ${record.lineNo} exceeds maxUploadChunkBytes (${policy.maxUploadChunkBytes})`,
      });
      continue;
    }
    const pendingStartOffset = pending[0]?.offset ?? record.offset;
    const spanBytes = record.offset + record.byteLength - pendingStartOffset;
    const wouldExceedBytes = pending.length > 0 && spanBytes > policy.maxUploadChunkBytes;
    const wouldExceedLines = pending.length >= policy.maxUploadLines;
    if (wouldExceedBytes || wouldExceedLines) {
      chunks.push(toChunk(file, pending, batch));
      pending = [];
    }
    pending.push(record);
  }

  if (pending.length) chunks.push(toChunk(file, pending, batch));
  return { chunks, skipped };
}

function toChunk(file: InventoryFile, records: TailRecord[], batch: TailBatch): UploadChunk {
  const generation = batch.nextCursor.generation;
  const first = records[0];
  const last = records[records.length - 1];
  const endOffset = last.offset + last.byteLength;
  const byteLength = endOffset - first.offset;
  const rawStart = first.offset - batch.rawStartOffset;
  const rawEnd = endOffset - batch.rawStartOffset;
  const rawBytes = batch.rawBytes.slice(Math.max(0, rawStart), Math.max(0, rawEnd));
  const rawText = new TextDecoder("utf-8").decode(rawBytes);
  const hash = createHash("sha256")
    .update(file.logicalId)
    .update(String(generation))
    .update(String(first.offset))
    .update(String(endOffset))
    .digest("hex")
    .slice(0, 24);

  return {
    chunkId: hash,
    generation,
    provider: file.provider,
    sourcePath: file.sourcePath,
    relativePath: file.relativePath,
    logicalId: file.logicalId,
    sessionId: file.sessionId,
    projectKey: file.projectKey,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    startOffset: first.offset,
    endOffset,
    startLine: first.lineNo,
    endLine: last.lineNo,
    byteLength,
    rawText,
    records,
  };
}
