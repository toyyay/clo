import index from "../../index.html";
import * as Y from "yjs";
import type {
  HostInfo,
  IngestBatchRequest,
  IngestBatchResponse,
  SessionInfo,
  SessionPayload,
  SyncRequest,
  SyncResponse,
  StreamMessage,
  YjsSocketMessage,
  YjsSyncRequest,
  YjsSyncResponse,
} from "../../packages/shared/types";
import { ensureSchema, sql, toId, toNumber } from "./db";

const port = Number(process.env.PORT ?? process.env.CHATVIEW_PORT ?? 3737);
const agentToken = process.env.CHATVIEW_AGENT_TOKEN ?? "dev-token";
const encoder = new TextEncoder();
const streamClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const yjsSocketsByDoc = new Map<string, Set<ServerWebSocket>>();
const docIdsBySocket = new WeakMap<ServerWebSocket, Set<string>>();

if (!process.env.CHATVIEW_AGENT_TOKEN) {
  console.warn("CHATVIEW_AGENT_TOKEN is not set; backend accepts the development token 'dev-token'");
}

await ensureSchema();

Bun.serve<{ docIds: Set<string> }>({
  port,
  routes: {
    "/": index,
    "/api/health": () => json({ ok: true }),
    "/api/hosts": async () => json(await listHosts()),
    "/api/sessions": async (req) => {
      const url = new URL(req.url);
      return json(await listSessions(url.searchParams.get("agentId") ?? undefined));
    },
    "/api/session": async (req) => {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (!id) return text("missing id", 400);
      const payload = await getSession(id);
      return payload ? json(payload) : text("session not found", 404);
    },
    "/api/sync": async (req) => {
      if (req.method !== "POST") return text("method not allowed", 405);
      const body = (await req.json().catch(() => ({}))) as SyncRequest;
      return json(await sync(body));
    },
    "/api/yjs/sync": async (req) => {
      if (req.method !== "POST") return text("method not allowed", 405);
      try {
        const body = (await req.json()) as YjsSyncRequest;
        return json(await syncYjs(body));
      } catch (error) {
        return text(error instanceof Error ? error.message : "bad request", 400);
      }
    },
    "/api/yjs/ws": (req, server) => {
      if (server.upgrade(req, { data: { docIds: new Set<string>() } })) return;
      return text("websocket upgrade failed", 400);
    },
    "/api/stream": (req) => stream(req),
    "/api/ingest/batch": async (req) => {
      if (req.method !== "POST") return text("method not allowed", 405);
      if (!isAuthorized(req)) return text("unauthorized", 401);
      try {
        const body = (await req.json()) as IngestBatchRequest;
        const result = await ingestBatch(body);
        return json(result);
      } catch (error) {
        return text(error instanceof Error ? error.message : "bad request", 400);
      }
    },
  },
  websocket: {
    open(ws) {
      docIdsBySocket.set(ws, ws.data.docIds);
    },
    async message(ws, rawMessage) {
      let message: YjsSocketMessage;
      try {
        message = JSON.parse(typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage));
      } catch {
        return;
      }

      if (message.type === "subscribe") {
        subscribeYjsSocket(ws, message.docIds);
        return;
      }

      if (message.type === "update") {
        const update = fromBase64(message.update);
        await mergeYjsUpdate(message.docId, update, message.sessionDbId);
        broadcastYjsUpdate(message.docId, message.update, ws);
      }
    },
    close(ws) {
      unsubscribeYjsSocket(ws);
    },
  },
  development: process.env.NODE_ENV !== "production",
});

console.log(`chatview backend running at http://localhost:${port}`);

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function text(value: string, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function isAuthorized(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${agentToken}`;
}

async function listHosts(): Promise<HostInfo[]> {
  const rows = await sql`
    select
      a.id,
      a.hostname,
      a.platform,
      a.arch,
      a.version,
      a.source_root,
      a.created_at,
      a.last_seen_at,
      count(distinct s.id) as session_count,
      count(e.id) as event_count
    from agents a
    left join chat_sessions s on s.agent_id = a.id
    left join session_events e on e.session_db_id = s.id
    group by a.id
    order by a.last_seen_at desc
  `;

  return rows.map((row: any) => ({
    agentId: row.id,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    version: row.version,
    sourceRoot: row.source_root,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    sessionCount: toNumber(row.session_count),
    eventCount: toNumber(row.event_count),
  }));
}

async function listSessions(agentId?: string): Promise<SessionInfo[]> {
  const rows = agentId
    ? await sql`
        select
          s.id,
          s.agent_id,
          a.hostname,
          p.project_key,
          p.display_name as project_name,
          s.session_id,
          s.title,
          s.source_path,
          s.size_bytes,
          s.mtime_ms,
          s.first_seen_at,
          s.last_seen_at,
          count(e.id) as event_count
        from chat_sessions s
        join agents a on a.id = s.agent_id
        join projects p on p.id = s.project_id
        left join session_events e on e.session_db_id = s.id
        where s.agent_id = ${agentId}
        group by s.id, a.hostname, p.project_key, p.display_name
        order by s.last_seen_at desc
      `
    : await sql`
        select
          s.id,
          s.agent_id,
          a.hostname,
          p.project_key,
          p.display_name as project_name,
          s.session_id,
          s.title,
          s.source_path,
          s.size_bytes,
          s.mtime_ms,
          s.first_seen_at,
          s.last_seen_at,
          count(e.id) as event_count
        from chat_sessions s
        join agents a on a.id = s.agent_id
        join projects p on p.id = s.project_id
        left join session_events e on e.session_db_id = s.id
        group by s.id, a.hostname, p.project_key, p.display_name
        order by s.last_seen_at desc
      `;

  return rows.map(mapSession);
}

async function getSession(id: string): Promise<SessionPayload | null> {
  const sessionRows = await sql`
    select
      s.id,
      s.agent_id,
      a.hostname,
      p.project_key,
      p.display_name as project_name,
      s.session_id,
      s.title,
      s.source_path,
      s.size_bytes,
      s.mtime_ms,
      s.first_seen_at,
      s.last_seen_at,
      count(e.id) as event_count
    from chat_sessions s
    join agents a on a.id = s.agent_id
    join projects p on p.id = s.project_id
    left join session_events e on e.session_db_id = s.id
    where s.id = ${id}
    group by s.id, a.hostname, p.project_key, p.display_name
  `;

  if (!sessionRows.length) return null;

  const eventRows = await sql`
    select id, source_line_no, source_offset, event_type, role, occurred_at, ingested_at, raw
    from session_events
    where session_db_id = ${id}
    order by source_line_no asc
  `;

  return {
    session: mapSession(sessionRows[0]),
    events: eventRows.map((row: any) => ({
      id: toId(row.id),
      sessionDbId: id,
      lineNo: toNumber(row.source_line_no),
      offset: toNumber(row.source_offset),
      eventType: row.event_type,
      role: row.role,
      createdAt: row.occurred_at,
      ingestedAt: row.ingested_at,
      raw: normalizeRaw(row.raw),
    })),
  };
}

async function sync(body: SyncRequest): Promise<SyncResponse> {
  const limitBytes = clamp(Math.floor(body.limitBytes ?? 2 * 1024 * 1024), 64 * 1024, 10 * 1024 * 1024);
  const cursor = BigInt(body.cursor && /^\d+$/.test(body.cursor) ? body.cursor : "0");
  const fetchLimit = 2500;
  const rows = await sql`
    select id, session_db_id, source_line_no, source_offset, event_type, role, occurred_at, ingested_at, raw
    from session_events
    where id > ${cursor}
    order by id asc
    limit ${fetchLimit}
  `;

  const events = [];
  let approxBytes = 2;
  let hasMore = rows.length === fetchLimit;

  for (const row of rows) {
    const event = {
      id: toId(row.id),
      sessionDbId: toId(row.session_db_id),
      lineNo: toNumber(row.source_line_no),
      offset: toNumber(row.source_offset),
      eventType: row.event_type,
      role: row.role,
      createdAt: row.occurred_at,
      ingestedAt: row.ingested_at,
      raw: normalizeRaw(row.raw),
    };
    const eventBytes = byteSize(JSON.stringify(event)) + 1;
    if (events.length && approxBytes + eventBytes > limitBytes) {
      hasMore = true;
      break;
    }
    events.push(event);
    approxBytes += eventBytes;
  }

  const nextCursor = events.length ? events[events.length - 1].id : cursor.toString();
  const sessionIds = [...new Set(events.map((event) => event.sessionDbId))];
  const sessions = [];

  for (const sessionId of sessionIds) {
    const payload = await getSession(sessionId);
    if (payload) sessions.push(payload.session);
  }

  const hosts = await listHosts();
  const response: SyncResponse = {
    cursor: nextCursor,
    hasMore,
    approxBytes: 0,
    hosts,
    sessions,
    events,
  };
  response.approxBytes = byteSize(JSON.stringify(response));
  return response;
}

function mapSession(row: any): SessionInfo {
  return {
    id: toId(row.id),
    agentId: row.agent_id,
    hostname: row.hostname,
    projectKey: row.project_key,
    projectName: row.project_name,
    sessionId: row.session_id,
    title: row.title,
    sourcePath: row.source_path,
    sizeBytes: toNumber(row.size_bytes),
    mtimeMs: toNumber(row.mtime_ms),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    eventCount: toNumber(row.event_count),
  };
}

async function ingestBatch(body: IngestBatchRequest): Promise<IngestBatchResponse> {
  validateBatch(body);

  await sql`
    insert into agents (id, hostname, platform, arch, version, source_root, last_seen_at)
    values (
      ${body.agent.agentId},
      ${body.agent.hostname},
      ${body.agent.platform},
      ${body.agent.arch},
      ${body.agent.version},
      ${body.agent.sourceRoot},
      now()
    )
    on conflict (id) do update set
      hostname = excluded.hostname,
      platform = excluded.platform,
      arch = excluded.arch,
      version = excluded.version,
      source_root = excluded.source_root,
      last_seen_at = now()
  `;

  let acceptedEvents = 0;
  const changedSessionIds = new Set<string>();

  for (const session of body.sessions) {
    const projectRows = await sql`
      insert into projects (agent_id, project_key, display_name, last_seen_at)
      values (${body.agent.agentId}, ${session.projectKey}, ${session.projectName ?? shortProject(session.projectKey)}, now())
      on conflict (agent_id, project_key) do update set
        display_name = excluded.display_name,
        last_seen_at = now()
      returning id
    `;
    const projectId = projectRows[0].id;
    const title = session.events.find((event) => event.title)?.title ?? null;

    const sessionRows = await sql`
      insert into chat_sessions (
        agent_id,
        project_id,
        session_id,
        source_path,
        title,
        size_bytes,
        mtime_ms,
        last_seen_at
      )
      values (
        ${body.agent.agentId},
        ${projectId},
        ${session.sessionId},
        ${session.sourcePath},
        ${title},
        ${session.sizeBytes},
        ${session.mtimeMs},
        now()
      )
      on conflict (agent_id, session_id) do update set
        project_id = excluded.project_id,
        source_path = excluded.source_path,
        title = coalesce(excluded.title, chat_sessions.title),
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        last_seen_at = now()
      returning id
    `;
    const sessionDbId = sessionRows[0].id;
    changedSessionIds.add(toId(sessionDbId));

    for (const event of session.events) {
      const inserted = await sql`
        insert into session_events (
          session_db_id,
          agent_id,
          source_line_no,
          source_offset,
          event_type,
          role,
          occurred_at,
          raw
        )
        values (
          ${sessionDbId},
          ${body.agent.agentId},
          ${event.lineNo},
          ${event.offset},
          ${event.eventType ?? null},
          ${event.role ?? null},
          ${event.createdAt ?? null},
          ${event.raw}::jsonb
        )
        on conflict (session_db_id, source_line_no) do nothing
        returning id
      `;
      acceptedEvents += inserted.length;
    }
  }

  if (changedSessionIds.size) {
    publish({
      type: "ingest",
      agentId: body.agent.agentId,
      sessionIds: [...changedSessionIds],
      acceptedEvents,
    });
  }

  return { ok: true, acceptedEvents, sessions: body.sessions.length };
}

async function syncYjs(body: YjsSyncRequest): Promise<YjsSyncResponse> {
  if (!Array.isArray(body?.docs)) throw new Error("invalid yjs sync payload");
  const docs = [];

  for (const doc of body.docs.slice(0, 100)) {
    if (!doc.docId || typeof doc.docId !== "string") throw new Error("invalid yjs doc id");

    if (doc.update) {
      const update = fromBase64(doc.update);
      await mergeYjsUpdate(doc.docId, update, doc.sessionDbId);
      broadcastYjsUpdate(doc.docId, doc.update);
    }

    const stored = await readYjsDocument(doc.docId);
    if (!stored) {
      docs.push({ docId: doc.docId });
      continue;
    }

    const stateVector = doc.stateVector ? fromBase64(doc.stateVector) : null;
    const diff = stateVector ? Y.diffUpdate(stored.update, stateVector) : stored.update;
    docs.push({
      docId: doc.docId,
      update: diff.length ? toBase64(diff) : undefined,
      updatedAt: stored.updatedAt,
    });
  }

  return { docs };
}

async function readYjsDocument(docId: string): Promise<{ update: Uint8Array; updatedAt: string } | null> {
  const rows = await sql`
    select update, updated_at
    from yjs_documents
    where doc_id = ${docId}
  `;
  if (!rows.length) return null;
  return {
    update: toBytes(rows[0].update),
    updatedAt: rows[0].updated_at,
  };
}

async function mergeYjsUpdate(docId: string, update: Uint8Array, sessionDbId?: string) {
  const current = await readYjsDocument(docId);
  const merged = current ? Y.mergeUpdates([current.update, update]) : update;
  await sql`
    insert into yjs_documents (doc_id, session_db_id, update, updated_at)
    values (${docId}, ${sessionDbId ?? null}, ${Buffer.from(merged)}, now())
    on conflict (doc_id) do update set
      session_db_id = coalesce(excluded.session_db_id, yjs_documents.session_db_id),
      update = excluded.update,
      updated_at = now()
  `;
}

function validateBatch(body: IngestBatchRequest) {
  if (!body?.agent?.agentId || !body.agent.hostname) throw new Error("invalid agent identity");
  if (!Array.isArray(body.sessions)) throw new Error("invalid sessions payload");
  for (const session of body.sessions) {
    if (!session.projectKey || !session.sessionId || !session.sourcePath) throw new Error("invalid session payload");
    if (!Array.isArray(session.events)) throw new Error("invalid session events");
  }
}

function stream(req: Request) {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      streamClients.add(controller);
      controller.enqueue(encoder.encode(": connected\n\n"));
      req.signal.addEventListener("abort", () => streamClients.delete(controller), { once: true });
    },
    cancel() {},
  });

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function publish(message: StreamMessage) {
  const payload = encoder.encode(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
  for (const controller of [...streamClients]) {
    try {
      controller.enqueue(payload);
    } catch {
      streamClients.delete(controller);
    }
  }
}

function subscribeYjsSocket(ws: ServerWebSocket, docIds: string[]) {
  const current = docIdsBySocket.get(ws) ?? new Set<string>();
  for (const docId of docIds.slice(0, 100)) {
    if (!docId) continue;
    current.add(docId);
    let sockets = yjsSocketsByDoc.get(docId);
    if (!sockets) {
      sockets = new Set();
      yjsSocketsByDoc.set(docId, sockets);
    }
    sockets.add(ws);
  }
  docIdsBySocket.set(ws, current);
}

function unsubscribeYjsSocket(ws: ServerWebSocket) {
  const docIds = docIdsBySocket.get(ws);
  if (!docIds) return;
  for (const docId of docIds) {
    const sockets = yjsSocketsByDoc.get(docId);
    sockets?.delete(ws);
    if (sockets?.size === 0) yjsSocketsByDoc.delete(docId);
  }
  docIds.clear();
}

function broadcastYjsUpdate(docId: string, update: string, except?: ServerWebSocket) {
  const sockets = yjsSocketsByDoc.get(docId);
  if (!sockets?.size) return;
  const payload = JSON.stringify({ type: "update", docId, update } satisfies YjsSocketMessage);
  for (const socket of sockets) {
    if (socket === except) continue;
    try {
      socket.send(payload);
    } catch {
      unsubscribeYjsSocket(socket);
    }
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function byteSize(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeRaw(raw: unknown) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toBase64(update: Uint8Array) {
  return Buffer.from(update).toString("base64");
}

function fromBase64(value: string) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === "string" && value.startsWith("\\x")) return new Uint8Array(Buffer.from(value.slice(2), "hex"));
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "binary"));
  throw new Error("unsupported bytea value");
}

function shortProject(raw: string) {
  return raw.replace(/^-Users-[^-]+-/, "").replace(/^p-?/, (match) => (match === "p" ? "p" : "")) || raw;
}
