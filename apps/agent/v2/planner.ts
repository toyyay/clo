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
    const chunked = chunkRecords(file, batch.records, policy);
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

function chunkRecords(file: InventoryFile, records: TailRecord[], policy: SyncPolicy): Pick<UploadPlan, "chunks" | "skipped"> {
  const chunks: UploadChunk[] = [];
  const skipped: UploadPlan["skipped"] = [];
  let pending: TailRecord[] = [];
  let pendingBytes = 0;

  for (const record of records) {
    if (record.byteLength > policy.maxUploadChunkBytes) {
      if (pending.length) {
        chunks.push(toChunk(file, pending));
        pending = [];
        pendingBytes = 0;
      }
      skipped.push({
        sourcePath: file.sourcePath,
        reason: `record at line ${record.lineNo} exceeds maxUploadChunkBytes (${policy.maxUploadChunkBytes})`,
      });
      continue;
    }
    const wouldExceedBytes = pendingBytes > 0 && pendingBytes + record.byteLength > policy.maxUploadChunkBytes;
    const wouldExceedLines = pending.length >= policy.maxUploadLines;
    if (wouldExceedBytes || wouldExceedLines) {
      chunks.push(toChunk(file, pending));
      pending = [];
      pendingBytes = 0;
    }
    pending.push(record);
    pendingBytes += record.byteLength;
  }

  if (pending.length) chunks.push(toChunk(file, pending));
  return { chunks, skipped };
}

function toChunk(file: InventoryFile, records: TailRecord[]): UploadChunk {
  const first = records[0];
  const last = records[records.length - 1];
  const endOffset = last.offset + last.byteLength;
  const byteLength = endOffset - first.offset;
  const hash = createHash("sha256")
    .update(file.logicalId)
    .update(String(first.offset))
    .update(String(endOffset))
    .digest("hex")
    .slice(0, 24);

  return {
    chunkId: hash,
    provider: file.provider,
    sourcePath: file.sourcePath,
    relativePath: file.relativePath,
    logicalId: file.logicalId,
    startOffset: first.offset,
    endOffset,
    startLine: first.lineNo,
    endLine: last.lineNo,
    byteLength,
    records,
  };
}
