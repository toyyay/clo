import type { SyncResponse } from "../../packages/shared/types";
import { applySync, getMeta } from "./db";

export type PullResult = {
  events: number;
  batches: number;
  cursor: string;
  hasMore: boolean;
  hosts: number;
  sessions: number;
  touchedSessionIds: string[];
};

export type PullProgress = {
  events: number;
  batches: number;
  hasMore: boolean;
};

export type PullOptions = {
  limitBytes?: number;
  maxBatches?: number;
  timeoutMs?: number;
  metadataOnly?: boolean;
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

const DEFAULT_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BATCHES = 4;
const DEFAULT_TIMEOUT_MS = 20_000;

async function fetchBatch(cursor: string, limitBytes: number, timeoutMs: number, metadataOnly: boolean): Promise<SyncResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor, limitBytes, metadataOnly }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401 || response.status === 403) throw new SyncAuthError(response.status, body);
      throw new Error(`sync failed: ${response.status} ${body}`);
    }
    return (await response.json()) as SyncResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("sync timed out");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function pullUpdates(options: PullOptions = {}): Promise<PullResult> {
  const limitBytes = options.limitBytes ?? DEFAULT_LIMIT_BYTES;
  const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_MAX_BATCHES);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const metadataOnly = options.metadataOnly === true;
  const onProgress = options.onProgress;
  let cursor = (await getMeta<string>("syncCursor")) ?? "0";
  let events = 0;
  let batches = 0;
  let hasMore = false;
  let hosts = 0;
  let sessions = 0;
  const touchedSessionIds = new Set<string>();

  while (batches < maxBatches) {
    const previousCursor = cursor;
    const payload = await fetchBatch(previousCursor, limitBytes, timeoutMs, metadataOnly);
    if (payload.hasMore && payload.cursor === previousCursor) throw new Error("sync cursor did not advance");
    cursor = payload.cursor;
    hasMore = payload.hasMore;
    hosts += payload.hosts.length;
    sessions += payload.sessions.length;
    await applySync(payload);
    for (const event of payload.events) touchedSessionIds.add(event.sessionDbId);
    events += payload.events.length;
    batches += 1;
    onProgress?.({ events, batches, hasMore: payload.hasMore });
    if (!payload.hasMore || metadataOnly) break;
  }

  return { events, batches, cursor, hasMore, hosts, sessions, touchedSessionIds: [...touchedSessionIds] };
}
