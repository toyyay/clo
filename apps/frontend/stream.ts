import type { StreamMessage } from "../../packages/shared/types";

export function openIngestStream(onMessage: (message: StreamMessage) => void, onError?: (error: Event) => void) {
  const source = new EventSource("/api/stream");
  source.addEventListener("ingest", (event) => {
    try {
      onMessage(JSON.parse((event as MessageEvent).data) as StreamMessage);
    } catch {
      // Ignore malformed stream messages; the polling sync path remains authoritative.
    }
  });
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}
