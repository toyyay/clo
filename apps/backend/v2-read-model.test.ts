import { describe, expect, test } from "bun:test";
import {
  getV2SessionsMeta,
  getV2Session,
  listV2EventsForBackfill,
  listV2Sessions,
  listV2EventsForSync,
  mapV2EventRow,
  mapV2SessionRow,
  mergeHostLists,
  normalizedEventToLegacyRaw,
  parseV2SessionId,
  v2SessionId,
} from "./v2-read-model";

describe("v2 read model helpers", () => {
  test("namespaces v2 session ids", () => {
    expect(v2SessionId(42n)).toBe("v3:42");
    expect(parseV2SessionId("v3:42")).toBe("42");
    expect(parseV2SessionId("42")).toBeNull();
  });

  test("maps source files into existing session info shape", () => {
    const session = mapV2SessionRow({
      id: 42,
      agent_id: "agent-1",
      hostname: "workstation",
      provider: "claude",
      source_kind: "conversation",
      current_generation: 3,
      source_path: "my-project/session-a.jsonl",
      size_bytes: 2048n,
      mtime_ms: 1234,
      content_sha256: "abc",
      mime_type: "application/x-ndjson",
      encoding: "utf8",
      line_count: 12,
      git: { repoRoot: "/repo", branch: "main", commit: "abc123", dirty: false, remoteUrl: "git@example.test/repo" },
      metadata: { title: "A chat" },
      first_seen_at: "2026-04-25T10:00:00.000Z",
      last_seen_at: "2026-04-25T10:05:00.000Z",
      event_count: 7n,
    });

    expect(session).toMatchObject({
      id: "v3:42",
      agentId: "agent-1",
      hostname: "workstation",
      sourceProvider: "claude",
      sourceKind: "conversation",
      sourceGeneration: 3,
      sourceId: "42",
      projectKey: "my-project",
      projectName: "my-project",
      sessionId: "session-a",
      title: "A chat",
      sourcePath: "my-project/session-a.jsonl",
      sizeBytes: 2048,
      eventCount: 7,
      gitRepoRoot: "/repo",
      gitBranch: "main",
      gitDirty: false,
    });
  });

  test("maps Codex cwd metadata into project grouping", () => {
    const session = mapV2SessionRow({
      id: 7,
      agent_id: "agent-1",
      hostname: "workstation",
      provider: "codex",
      source_kind: "conversation",
      current_generation: 1,
      source_path: "2026/04/25/rollout.jsonl",
      size_bytes: 100n,
      mtime_ms: 1,
      git: {},
      metadata: { cwd: "/Users/example/p/chatview", sessionId: "thread-1" },
      first_seen_at: "2026-04-25T10:00:00.000Z",
      last_seen_at: "2026-04-25T10:05:00.000Z",
      event_count: 3n,
    });

    expect(session).toMatchObject({
      sourceProvider: "codex",
      projectKey: "-Users-example-p-chatview",
      projectName: "chatview",
      sessionId: "thread-1",
    });
  });

  test("ignores redacted Codex ids and keeps thread names as titles", () => {
    const session = mapV2SessionRow({
      id: 8,
      agent_id: "agent-1",
      hostname: "workstation",
      provider: "codex",
      source_kind: "conversation",
      current_generation: 1,
      source_path: "2026/04/26/rollout-2026-04-26T10-11-31-019dc8d7-fe98-7531-bb1f-6d5019833f8b.jsonl",
      size_bytes: 100n,
      mtime_ms: 1,
      git: {},
      metadata: { cwd: "/Users/example/p/chatview", sessionId: "<redacted>", title: "Улучшить интерфейс чатов" },
      first_seen_at: "2026-04-26T08:11:34.000Z",
      last_seen_at: "2026-04-26T08:15:43.000Z",
      event_count: 80n,
    });

    expect(session.sessionId).toBe("rollout-2026-04-26T10-11-31-019dc8d7-fe98-7531-bb1f-6d5019833f8b");
    expect(session.title).toBe("Улучшить интерфейс чатов");
  });

  test("maps normalized event parts into renderable legacy raw payloads", () => {
    const event = mapV2EventRow({
      id: 99,
      source_file_id: 42,
      source_line_no: 5,
      source_offset: 123,
      event_type: "message",
      role: "assistant",
      occurred_at: "2026-04-25T10:01:00.000Z",
      created_at: "2026-04-25T10:01:01.000Z",
      normalized: {
        kind: "message",
        role: "assistant",
        display: true,
        parts: [
          { kind: "thinking", text: "checking" },
          { kind: "text", text: "hello" },
          { kind: "tool_call", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        ],
      },
    });

    expect(event).toMatchObject({
      id: "v2e:99",
      sessionDbId: "v3:42",
      lineNo: 5,
      offset: 123,
      eventType: "message",
      role: "assistant",
      createdAt: "2026-04-25T10:01:00.000Z",
      ingestedAt: "2026-04-25T10:01:01.000Z",
    });
    expect(event.raw).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking" },
          { type: "text", text: "hello" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        ],
      },
    });
  });

  test("keeps non-display normalized events out of the legacy transcript surface", () => {
    const raw = normalizedEventToLegacyRaw({
      kind: "session",
      role: "system",
      display: false,
      parts: [{ kind: "event", name: "session_configured" }],
    });

    expect(raw).toEqual({
      type: "session",
      normalized: {
        kind: "session",
        role: "system",
        display: false,
        parts: [{ kind: "event", name: "session_configured" }],
      },
    });
  });

  test("repairs old Codex payload events when reading v2 transcripts", () => {
    const raw = normalizedEventToLegacyRaw({
      kind: "event",
      role: "system",
      display: false,
      source: { provider: "codex", rawType: "response_item", rawKind: "response_item" },
      parts: [
        {
          kind: "event",
          name: "response_item",
          data: {
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "visible now" }],
            },
          },
        },
      ],
    });

    expect(raw).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "visible now" }],
      },
    });
  });

  test("repairs old Codex event_msg agent messages into markdown-capable assistant text", () => {
    const raw = normalizedEventToLegacyRaw({
      kind: "event",
      role: "system",
      display: false,
      source: { provider: "codex", rawType: "event_msg", rawKind: "agent_message" },
      parts: [
        {
          kind: "event",
          name: "agent_message",
          data: {
            payload: {
              type: "agent_message",
              message: "**Done**\n\n- one\n- two",
            },
          },
        },
      ],
    });

    expect(raw).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "**Done**\n\n- one\n- two" }],
      },
    });
  });

  test("direct v2 session lookups exclude deleted source files", async () => {
    const { calls, sql } = recordingSql();

    await getV2Session(sql, "v3:42");

    expect(calls).toHaveLength(1);
    expect(normalizeSql(calls[0].text)).toContain("where f.id = ? and f.source_kind = 'conversation' and f.deleted_at is null");
    expect(calls[0].values).toEqual([null, null, "42", null, null]);
  });

  test("sync v2 event query uses durable sync revisions", async () => {
    const { calls, sql } = recordingSql();

    await listV2EventsForSync(sql, 10n, 25);

    expect(calls).toHaveLength(1);
    const text = normalizeSql(calls[0].text);
    expect(text).not.toContain("row_number() over");
    expect(text).toContain("and e.sync_revision > ?");
    expect(text).toContain("order by e.sync_revision asc, e.id asc");
    expect(text).toContain("and f.source_kind = 'conversation' and f.deleted_at is null");
    expect(calls[0].values).toEqual([10n, null, null, 25]);
  });

  test("backfill v2 event query walks older sync revisions", async () => {
    const { calls, sql } = recordingSql();

    await listV2EventsForBackfill(sql, 100n, 150n, 25);

    expect(calls).toHaveLength(1);
    const text = normalizeSql(calls[0].text);
    expect(text).not.toContain("row_number() over");
    expect(text).toContain("and e.sync_revision < ? and e.sync_revision <= ?");
    expect(text).toContain("and f.source_kind = 'conversation' and f.deleted_at is null");
    expect(text).toContain("order by e.sync_revision desc, e.id desc");
    expect(calls[0].values).toEqual([100n, 150n, null, null, 25]);
  });

  test("v2 event sync can be limited to a frontend retention window", async () => {
    const { calls, sql } = recordingSql();

    await listV2EventsForSync(sql, 10n, 25, "2026-04-13T00:00:00.000Z");

    const text = normalizeSql(calls[0].text);
    expect(text).toContain("coalesce(e.occurred_at, e.created_at) >= ?::timestamptz");
    expect(calls[0].values).toEqual([10n, "2026-04-13T00:00:00.000Z", "2026-04-13T00:00:00.000Z", 25]);
  });

  test("v2 metadata lookup can return deleted tombstones for delta sync", async () => {
    const { calls, sql } = recordingSql();

    await getV2SessionsMeta(sql, ["42"], { includeDeleted: true });

    expect(calls).toHaveLength(1);
    const text = normalizeSql(calls[0].text);
    expect(text).toContain("where f.id = any(?::bigint[]) and f.source_kind = 'conversation'");
    expect(text).not.toContain("and f.deleted_at is null");
  });

  test("v2 session list can derive titles from visible user text", async () => {
    const { calls, sql } = recordingSql();

    await listV2Sessions(sql);

    expect(calls).toHaveLength(1);
    const text = normalizeSql(calls[0].text);
    expect(text).toContain("nullif(e.normalized #>> '{parts,0,text}', '')");
    expect(text).toContain("e.normalized ->> 'display' = 'true'");
    expect(text).toContain("coalesce(e.normalized ->> 'role', e.role) = 'user'");
  });

  test("merges legacy and v2 host counts without dropping host metadata", () => {
    const hosts = mergeHostLists(
      [
        {
          agentId: "agent-1",
          hostname: "old-host",
          createdAt: "2026-04-25T09:00:00.000Z",
          lastSeenAt: "2026-04-25T09:30:00.000Z",
          sessionCount: 2,
          eventCount: 10,
        },
      ],
      [
        {
          agentId: "agent-1",
          hostname: "new-host",
          platform: "darwin",
          createdAt: "2026-04-25T09:15:00.000Z",
          lastSeenAt: "2026-04-25T10:30:00.000Z",
          sessionCount: 3,
          eventCount: 20,
        },
      ],
    );

    expect(hosts).toEqual([
      {
        agentId: "agent-1",
        hostname: "new-host",
        platform: "darwin",
        createdAt: "2026-04-25T09:00:00.000Z",
        lastSeenAt: "2026-04-25T10:30:00.000Z",
        sessionCount: 5,
        eventCount: 30,
      },
    ]);
  });
});

function recordingSql(rows: any[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: Array.from(strings).join("?"), values });
    return rows;
  }) as any;
  return { calls, sql };
}

function normalizeSql(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
