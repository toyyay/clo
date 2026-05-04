// Sync-v3 telemetry: persist WS session lifecycle and key events to Postgres
// for in-DB diagnostics. Designed to be cheap on the hot path:
//   * sessionRow created on WS open, updated on close; one INSERT, one UPDATE.
//   * logEvent is fire-and-forget INSERT — failures are swallowed because a
//     telemetry hiccup must never break sync.
//   * For very high frequency events (every batch.sent) we throttle: caller
//     decides when to log.
//
// Schema lives in migrations.ts:0016 (v3_client_sessions, v3_sync_events).

export type TelemetrySessionInput = {
  clientId: string;
  userAgent: string | null;
  ip: string | null;
  deviceMemoryGb: number | null;
  protocolVersion: number;
  viewsAtOpen: unknown[];
  metadata?: Record<string, unknown>;
};

export type TelemetryEventInput = {
  clientId?: string | null;
  viewId?: string | null;
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  durationMs?: number | null;
  bytes?: number | null;
  payload?: Record<string, unknown>;
};

export type Telemetry = {
  /** Returns the inserted session id, or null if telemetry is disabled / failed. */
  recordSessionOpen(input: TelemetrySessionInput): Promise<number | null>;
  recordSessionClose(sessionId: number, code: number, reason: string | null): Promise<void>;
  recordSessionPing(sessionId: number): Promise<void>;
  log(event: TelemetryEventInput): void;
};

export function makePostgresTelemetry(sql: any): Telemetry {
  return {
    async recordSessionOpen(input) {
      try {
        const rows = await sql`
          insert into v3_client_sessions (
            client_id, user_agent, ip, device_memory_gb, protocol_version,
            views_at_open, metadata
          )
          values (
            ${input.clientId}, ${input.userAgent}, ${input.ip},
            ${input.deviceMemoryGb}, ${input.protocolVersion},
            ${JSON.stringify(input.viewsAtOpen)}::jsonb,
            ${JSON.stringify(input.metadata ?? {})}::jsonb
          )
          returning id
        `;
        return Number(rows[0]?.id ?? 0) || null;
      } catch (err) {
        console.warn("[v3 telemetry] recordSessionOpen failed", err);
        return null;
      }
    },

    async recordSessionClose(sessionId, code, reason) {
      try {
        await sql`
          update v3_client_sessions
          set disconnected_at = now(),
              close_code = ${code},
              close_reason = ${reason},
              last_seen_at = now()
          where id = ${sessionId}
        `;
      } catch (err) {
        console.warn("[v3 telemetry] recordSessionClose failed", err);
      }
    },

    async recordSessionPing(sessionId) {
      try {
        await sql`update v3_client_sessions set last_seen_at = now() where id = ${sessionId}`;
      } catch (err) {
        // ignore — periodic pings missing isn't critical
      }
    },

    log(event) {
      // Fire-and-forget. Don't await.
      const level = event.level ?? "info";
      void (async () => {
        try {
          await sql`
            insert into v3_sync_events (
              client_id, view_id, event, level, duration_ms, bytes, payload
            )
            values (
              ${event.clientId ?? null}, ${event.viewId ?? null}, ${event.event},
              ${level}, ${event.durationMs ?? null}, ${event.bytes ?? null},
              ${JSON.stringify(event.payload ?? {})}::jsonb
            )
          `;
        } catch (err) {
          // Avoid recursion: telemetry errors → console only.
          if (level === "error" || level === "warn") {
            console.warn("[v3 telemetry] log insert failed", err);
          }
        }
      })();
    },
  };
}

/** Make a no-op telemetry for tests. */
export function makeNoopTelemetry(): Telemetry {
  return {
    async recordSessionOpen() {
      return null;
    },
    async recordSessionClose() {},
    async recordSessionPing() {},
    log() {},
  };
}
