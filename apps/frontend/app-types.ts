import type { SessionEvent } from "../../packages/shared/types";

export type SyncState = "loading" | "syncing" | "idle" | "offline" | "error";
export type AuthState = "checking" | "authenticated" | "anonymous";
export type EventState = { sessionId: string | null; events: SessionEvent[] };
export type SyncNowOptions = { silent?: boolean; metadataOnly?: boolean };
