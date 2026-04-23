import type { SyncResponse } from "../../packages/shared/types";
import { applySync, getMeta } from "./db";

export type PullResult = {
  events: number;
  batches: number;
  cursor: string;
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

export async function pullUpdates(limitBytes = DEFAULT_LIMIT_BYTES): Promise<PullResult> {
  let cursor = (await getMeta<string>("syncCursor")) ?? "0";
  let events = 0;
  let batches = 0;

  for (;;) {
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

    const payload = (await response.json()) as SyncResponse;
    await applySync(payload);
    cursor = payload.cursor;
    events += payload.events.length;
    batches += 1;

    if (!payload.hasMore) break;
  }

  return { events, batches, cursor };
}
