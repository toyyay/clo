import type { SessionEvent } from "../../packages/shared/types";

export type SyncState = "loading" | "syncing" | "idle" | "offline" | "error";
export type SyncHealth = {
  online: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};
export type AuthState = "checking" | "authenticated" | "cache" | "anonymous";
export type EventState = {
  sessionId: string | null;
  events: SessionEvent[];
  windowed?: boolean;
  hasOlder?: boolean;
  hasNewer?: boolean;
};
export type SyncEventMode = "forward" | "recent" | "backfill";
export type SyncNowOptions = { silent?: boolean; metadataOnly?: boolean; eventMode?: SyncEventMode };
