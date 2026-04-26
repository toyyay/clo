import type { StreamMessage } from "../../packages/shared/types";

export type StreamHeartbeatMessage = {
  type: "heartbeat";
  streamSeq?: number;
  sentAt?: string;
  clientCount?: number;
};

export type IngestStreamHandlers = {
  onOpen?: (event: Event, readyState: number) => void;
  onMessage: (message: StreamMessage, readyState: number) => void;
  onHeartbeat?: (message: StreamHeartbeatMessage, readyState: number) => void;
  onError?: (error: Event, readyState: number) => void;
  onMalformed?: (error: unknown, data: string, eventType: "ingest" | "heartbeat") => void;
};

export function openIngestStream(handlers: IngestStreamHandlers) {
  if (typeof EventSource === "undefined") {
    window.setTimeout(() => handlers.onError?.(new Event("error"), 2), 0);
    return () => {};
  }

  const source = new EventSource("/api/stream");
  source.addEventListener("open", (event) => {
    handlers.onOpen?.(event, source.readyState);
  });
  source.addEventListener("ingest", (event) => {
    try {
      handlers.onMessage(JSON.parse((event as MessageEvent).data) as StreamMessage, source.readyState);
    } catch (error) {
      handlers.onMalformed?.(error, (event as MessageEvent).data, "ingest");
    }
  });
  source.addEventListener("heartbeat", (event) => {
    try {
      handlers.onHeartbeat?.(JSON.parse((event as MessageEvent).data) as StreamHeartbeatMessage, source.readyState);
    } catch (error) {
      handlers.onMalformed?.(error, (event as MessageEvent).data, "heartbeat");
    }
  });
  source.addEventListener("error", (event) => {
    handlers.onError?.(event, source.readyState);
  });
  return () => source.close();
}
