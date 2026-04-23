import type { SyncResponse } from "../../packages/shared/types";
import { applySync, getMeta } from "./db";

export type PullResult = {
  events: number;
  batches: number;
  cursor: string;
};

export type PullProgress = {
  events: number;
  batches: number;
  hasMore: boolean;
};

export type PullOptions = {
  limitBytes?: number;
  onProgress?: (progress: PullProgress) => void;
};

export class SyncAuthError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`sync failed: ${status} ${body}`);
    this.name = "SyncAuthError";
    this.status = status;
  }
}

const DEFAULT_LIMIT_BYTES = 8 * 1024 * 1024;

async function fetchBatch(cursor: string, limitBytes: number): Promise<SyncResponse> {
  const response = await fetch("/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cursor, limitBytes }),
  });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401 || response.status === 403) throw new SyncAuthError(response.status, body);
    throw new Error(`sync failed: ${response.status} ${body}`);
  }
  return (await response.json()) as SyncResponse;
}

export async function pullUpdates(options: PullOptions = {}): Promise<PullResult> {
  const limitBytes = options.limitBytes ?? DEFAULT_LIMIT_BYTES;
  const onProgress = options.onProgress;
  let cursor = (await getMeta<string>("syncCursor")) ?? "0";
  let events = 0;
  let batches = 0;

  let pending: Promise<SyncResponse> = fetchBatch(cursor, limitBytes);

  for (;;) {
    const payload = await pending;
    cursor = payload.cursor;
    // Kick off the next network request before we block on IndexedDB so the
    // two pipelines overlap — server hands over the next batch while the
    // client persists the current one.
    const next = payload.hasMore ? fetchBatch(cursor, limitBytes) : null;
    await applySync(payload);
    events += payload.events.length;
    batches += 1;
    onProgress?.({ events, batches, hasMore: payload.hasMore });
    if (!next) break;
    pending = next;
  }

  return { events, batches, cursor };
}
