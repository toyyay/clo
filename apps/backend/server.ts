import index from "../../index.html";
import { createHash, timingSafeEqual } from "node:crypto";
import * as Y from "yjs";
import type { ServerWebSocket } from "bun";
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
import { downloadAgentArchiveResponse } from "./agent-download";
import { envFlag, envValue } from "../../packages/shared/env";
import { prepareDatabase, sql, toId, toNumber } from "./db";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(envValue(process.env, "PORT", "CHATVIEW_PORT") ?? 3737);
const agentToken = envValue(process.env, "AGENT_TOKEN", "CHATVIEW_AGENT_TOKEN") ?? (isProduction ? "" : "dev-token");
const webToken = envValue(process.env, "WEB_TOKEN", "CHATVIEW_WEB_TOKEN") ?? "";
const importStoreBody = envFlag(process.env, ["IMPORT_STORE_BODY", "CHATVIEW_IMPORT_STORE_BODY"]);
const webAuthCookie = "chatview_token";
const webAuthCookieMaxAge = 60 * 60 * 24 * 30;
const gitSha = process.env.GIT_SHA ?? "unknown";
const encoder = new TextEncoder();
const streamClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const redactedHeaderNames = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
const redactedQueryNames = new Set(["token"]);
type YjsWebSocket = ServerWebSocket<{ docIds: Set<string> }>;
const yjsSocketsByDoc = new Map<string, Set<YjsWebSocket>>();
const docIdsBySocket = new WeakMap<YjsWebSocket, Set<string>>();

if (!agentToken) {
  throw new Error("AGENT_TOKEN is required in production");
}

if (!envValue(process.env, "AGENT_TOKEN", "CHATVIEW_AGENT_TOKEN")) {
  console.warn("AGENT_TOKEN is not set; backend accepts the development token 'dev-token'");
}

if (isProduction && !webToken) {
  throw new Error("WEB_TOKEN is required in production");
}

if (!webToken) {
  console.warn("WEB_TOKEN is not set; web UI login is disabled and protected browser APIs return 401");
}

await prepareDatabase();

Bun.serve<{ docIds: Set<string> }>({
  port,
  routes: {
    "/": index,
    "/api/health": () => json({ ok: true, commit_sha: gitSha }),
    "/api/auth/status": (req: Request) => json({ configured: Boolean(webToken), authenticated: isWebAuthorized(req) }),
    "/api/auth/login": async (req: Request) => {
      if (req.method !== "POST") return text("method not allowed", 405);
      if (!webToken) return text("auth token is not configured", 503);

      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      if (!tokenMatches(typeof body.token === "string" ? body.token : "", webToken)) {
        return text("unauthorized", 401);
      }

      return json({ ok: true }, 200, { "set-cookie": makeWebAuthCookie(req, webToken) });
    },
    "/api/auth/logout": (req: Request) => json({ ok: true }, 200, { "set-cookie": clearWebAuthCookie(req) }),
    "/status-9c8e0f3a2b71": () => json({ ok: true, commit_sha: gitSha, uptime: Math.round(process.uptime()) }),
    "/api/hosts": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      return json(await listHosts());
    },
    "/api/sessions": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      const url = new URL(req.url);
      return json(await listSessions(url.searchParams.get("agentId") ?? undefined));
    },
    "/api/session": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (!id) return text("missing id", 400);
      const payload = await getSession(id);
      return payload ? json(payload) : text("session not found", 404);
    },
    "/api/sync": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method !== "POST") return text("method not allowed", 405);
      const body = (await req.json().catch(() => ({}))) as SyncRequest;
      return json(await sync(body));
    },
    "/api/yjs/sync": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method !== "POST") return text("method not allowed", 405);
      try {
        const body = (await req.json()) as YjsSyncRequest;
        return json(await syncYjs(body));
      } catch (error) {
        return text(error instanceof Error ? error.message : "bad request", 400);
      }
    },
    "/api/yjs/ws": (req: Request, server: { upgrade(req: Request, options: { data: { docIds: Set<string> } }): boolean }) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (server.upgrade(req, { data: { docIds: new Set<string>() } })) return;
      return text("websocket upgrade failed", 400);
    },
    "/api/stream": (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      return stream(req);
    },
    "/api/agent/download": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      return downloadAgentArchiveResponse(req, agentToken);
    },
    "/api/ingest/batch": async (req: Request) => {
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
    "/api/imports/media": async (req: Request) => handleImportMedia(req),
    "/api/shortcuts/audio": async (req: Request) => handleImportMedia(req),
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
  development: !isProduction,
});

console.log(`chatview backend running at http://localhost:${port}`);

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, { status, headers });
}

function text(value: string, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function isAuthorized(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${agentToken}`;
}

function requireWebAuth(req: Request) {
  return isWebAuthorized(req) ? null : text("unauthorized", 401);
}

function isWebAuthorized(req: Request) {
  return tokenMatches(readCookie(req, webAuthCookie), webToken);
}

function readCookie(req: Request, name: string) {
  const cookie = req.headers.get("cookie");
  if (!cookie) return "";

  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return "";
    }
  }

  return "";
}

function makeWebAuthCookie(req: Request, token: string) {
  const parts = [
    `${webAuthCookie}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${webAuthCookieMaxAge}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearWebAuthCookie(req: Request) {
  const parts = [`${webAuthCookie}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

function isHttps(req: Request) {
  const forwardedProto = req.headers.get("x-forwarded-proto");
  return process.env.NODE_ENV === "production" || forwardedProto === "https" || new URL(req.url).protocol === "https:";
}

function tokenMatches(candidate: string | undefined, expected: string) {
  if (!candidate || !expected) return false;
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function readImportToken(req: Request, url: URL) {
  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return bearer[1].trim();
  return url.searchParams.get("token") ?? "";
}

function redactSensitiveUrl(url: URL) {
  const sanitized = new URL(url);
  for (const key of redactedQueryNames) {
    if (sanitized.searchParams.has(key)) sanitized.searchParams.set(key, "<redacted>");
  }
  return sanitized.toString();
}

type ImportMediaCandidate = {
  sourceKind: string;
  partIndex: number;
  partName?: string;
  filename?: string;
  contentType?: string;
  bytes: Buffer;
  metadata: Record<string, unknown>;
};

type MediaDetection = {
  kind: "audio";
  format: string;
  metadata: Record<string, unknown>;
};

async function handleImportMedia(req: Request) {
  const url = new URL(req.url);
  const tokenValue = readImportToken(req, url);
  const rawBody = Buffer.from(await req.clone().arrayBuffer());
  const tokenRows = tokenValue
    ? await sql`
        select id, token
        from import_tokens
        where token = ${tokenValue}
      `
    : [];

  const requestId = await createImportRequestLog(req, url, rawBody, tokenRows[0]?.id ?? null, tokenValue || null);

  try {
    if (req.method !== "POST") {
      return finishImportResponse(requestId, { ok: false, requestId, error: "method not allowed" }, 405);
    }

    if (!tokenRows.length) {
      return finishImportResponse(requestId, { ok: false, requestId, error: "unauthorized" }, 401);
    }

    await sql`
      update import_tokens
      set last_used_at = now()
      where id = ${tokenRows[0].id}
    `;

    const result = await ingestImportMedia(req, rawBody, requestId);
    return finishImportResponse(requestId, { ok: true, requestId, ...result }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "import ingest failed";
    return finishImportResponse(requestId, { ok: false, requestId, error: message }, 500);
  }
}

async function createImportRequestLog(
  req: Request,
  url: URL,
  rawBody: Buffer,
  tokenId: unknown,
  tokenValue: string | null,
) {
  const storedRequestBody = importStoreBody ? rawBody : Buffer.alloc(0);
  const rows = await sql`
    insert into import_requests (
      token_id,
      token_sha256,
      method,
      url,
      path,
      query,
      request_headers,
      request_content_type,
      request_body,
      request_body_sha256,
      request_body_bytes
    )
    values (
      ${tokenId},
      ${tokenValue ? sha256Hex(Buffer.from(tokenValue, "utf8")) : null},
      ${req.method},
      ${redactSensitiveUrl(url)},
      ${url.pathname},
      ${queryToJson(url, redactedQueryNames)}::jsonb,
      ${headersToJson(req.headers)}::jsonb,
      ${req.headers.get("content-type")},
      ${storedRequestBody},
      ${sha256Hex(rawBody)},
      ${rawBody.length}
    )
    returning id
  `;
  return rows[0].id;
}

async function finishImportResponse(requestId: unknown, payload: Record<string, unknown>, status: number) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  const storedBody = importStoreBody ? body : Buffer.alloc(0);
  const headers = { "content-type": "application/json; charset=utf-8" };
  const error = payload.ok === false ? String(payload.error ?? "request failed") : null;

  await sql`
    update import_requests
    set
      response_status = ${status},
      response_headers = ${headers}::jsonb,
      response_body = ${storedBody},
      response_body_sha256 = ${sha256Hex(body)},
      response_body_bytes = ${body.length},
      error = ${error},
      responded_at = now()
    where id = ${requestId}
  `;

  return new Response(body, { status, headers });
}

async function ingestImportMedia(req: Request, rawBody: Buffer, requestId: unknown) {
  const candidates = await extractImportMediaCandidates(req, rawBody);
  const savedMedia = [];

  for (const candidate of candidates) {
    const detection = detectMedia(candidate.bytes, candidate.contentType, candidate.filename);
    if (!detection) continue;

    const metadata = {
      ...candidate.metadata,
      ...detection.metadata,
    };
    const mediaRows = await sql`
      insert into import_media_blobs (
        media_kind,
        sha256,
        bytes,
        size_bytes,
        content_type,
        filename,
        extension,
        detected_format,
        metadata,
        last_seen_at
      )
      values (
        ${detection.kind},
        ${sha256Hex(candidate.bytes)},
        ${candidate.bytes},
        ${candidate.bytes.length},
        ${candidate.contentType ?? null},
        ${candidate.filename ?? null},
        ${fileExtension(candidate.filename) ?? null},
        ${detection.format},
        ${metadata}::jsonb,
        now()
      )
      on conflict (sha256) do update set
        last_seen_at = now(),
        content_type = coalesce(import_media_blobs.content_type, excluded.content_type),
        filename = coalesce(import_media_blobs.filename, excluded.filename),
        extension = coalesce(import_media_blobs.extension, excluded.extension),
        detected_format = coalesce(import_media_blobs.detected_format, excluded.detected_format),
        metadata = import_media_blobs.metadata || excluded.metadata
      returning id, media_kind, sha256, size_bytes, content_type, filename, detected_format, metadata
    `;
    const media = mediaRows[0];

    await sql`
      insert into import_request_media (
        request_id,
        media_id,
        part_index,
        part_name,
        source_kind,
        filename,
        content_type,
        size_bytes,
        metadata
      )
      values (
        ${requestId},
        ${media.id},
        ${candidate.partIndex},
        ${candidate.partName ?? null},
        ${candidate.sourceKind},
        ${candidate.filename ?? null},
        ${candidate.contentType ?? null},
        ${candidate.bytes.length},
        ${metadata}::jsonb
      )
      on conflict (request_id, part_index) do nothing
    `;

    savedMedia.push({
      id: toId(media.id),
      mediaKind: media.media_kind,
      sha256: media.sha256,
      sizeBytes: toNumber(media.size_bytes),
      contentType: media.content_type,
      filename: media.filename,
      detectedFormat: media.detected_format,
      createdAt: typeof metadata.createdAt === "string" ? metadata.createdAt : null,
    });
  }

  return {
    rawRequestBytes: rawBody.length,
    candidates: candidates.length,
    mediaFiles: savedMedia.length,
    media: savedMedia,
    audioFiles: savedMedia.length,
    audio: savedMedia,
  };
}

async function extractImportMediaCandidates(req: Request, rawBody: Buffer): Promise<ImportMediaCandidate[]> {
  const contentType = req.headers.get("content-type") ?? "";
  const candidates: ImportMediaCandidate[] = [];

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const form = await req.formData();
    let index = 0;

    for (const [name, value] of form.entries()) {
      if (isUploadedFile(value)) {
        candidates.push({
          sourceKind: "multipart-file",
          partIndex: index,
          partName: name,
          filename: value.name || undefined,
          contentType: value.type || undefined,
          bytes: Buffer.from(await value.arrayBuffer()),
          metadata: {
            formField: name,
            fileLastModifiedMs: value.lastModified || null,
            fileLastModifiedAt: value.lastModified ? new Date(value.lastModified).toISOString() : null,
          },
        });
      } else {
        pushBase64MediaCandidates(candidates, value, {
          sourceKind: "multipart-field-base64",
          partIndex: index,
          partName: name,
          metadata: { formField: name },
        });
      }
      index += 1;
    }

    return candidates;
  }

  if (contentType.toLowerCase().includes("json")) {
    try {
      const parsed = JSON.parse(rawBody.toString("utf8"));
      pushJsonMediaCandidates(candidates, parsed);
      if (candidates.length) return candidates;
    } catch {
      // Keep the body hash for audit purposes and fall back to raw media detection below.
    }
  }

  candidates.push({
    sourceKind: "raw-body",
    partIndex: 0,
    filename: filenameFromContentDisposition(req.headers.get("content-disposition")),
    contentType: contentType || undefined,
    bytes: rawBody,
    metadata: {},
  });
  return candidates;
}

function isUploadedFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as File).arrayBuffer === "function" &&
    typeof (value as File).name === "string"
  );
}

function pushJsonMediaCandidates(candidates: ImportMediaCandidate[], value: unknown, path: string[] = [], depth = 0) {
  if (depth > 12 || candidates.length >= 50) return;

  if (typeof value === "string") {
    pushBase64MediaCandidates(candidates, value, {
      sourceKind: "json-base64",
      partIndex: candidates.length,
      partName: path.join(".") || "$",
      metadata: { jsonPath: path.join(".") || "$" },
    });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => pushJsonMediaCandidates(candidates, item, [...path, String(index)], depth + 1));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      pushJsonMediaCandidates(candidates, item, [...path, key], depth + 1);
    }
  }
}

function pushBase64MediaCandidates(
  candidates: ImportMediaCandidate[],
  value: string,
  defaults: Omit<ImportMediaCandidate, "bytes">,
) {
  const trimmed = value.trim();
  const dataUrl = trimmed.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is);
  const contentType = dataUrl?.[1] || defaults.contentType;
  const base64 = dataUrl?.[2] ?? trimmed;
  const compact = base64.replace(/\s+/g, "");

  if (compact.length < 24 || compact.length % 4 !== 0 || !/^[a-z0-9+/]+={0,2}$/i.test(compact)) return;

  try {
    const bytes = Buffer.from(compact, "base64");
    if (!detectMedia(bytes, contentType, defaults.filename)) return;
    candidates.push({
      ...defaults,
      contentType,
      bytes,
      metadata: {
        ...defaults.metadata,
        dataUrl: Boolean(dataUrl),
      },
    });
  } catch {
    return;
  }
}

function detectMedia(bytes: Uint8Array, contentType?: string, filename?: string): MediaDetection | null {
  const lowerType = contentType?.toLowerCase() ?? "";
  const extension = fileExtension(filename);

  if (isMp4Like(bytes)) {
    const metadata = parseMp4Metadata(Buffer.from(bytes));
    return { kind: "audio", format: metadata.majorBrand === "qt  " ? "quicktime" : "m4a/mp4", metadata };
  }
  if (startsWithAscii(bytes, 0, "caff")) return { kind: "audio", format: "caf", metadata: {} };
  if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WAVE")) return { kind: "audio", format: "wav", metadata: {} };
  if (startsWithAscii(bytes, 0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return { kind: "audio", format: "mp3", metadata: {} };
  }

  if (lowerType.startsWith("audio/") || ["m4a", "mp4", "mov", "qta", "caf", "wav", "aac", "mp3"].includes(extension ?? "")) {
    return { kind: "audio", format: lowerType || extension || "audio", metadata: {} };
  }

  return null;
}

function parseMp4Metadata(bytes: Buffer): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const tags: Record<string, string> = {};
  const brands: string[] = [];
  const creationTimes: string[] = [];
  const durations: number[] = [];

  scanMp4Boxes(bytes, 0, bytes.length, [], 0, (box) => {
    if (box.type === "ftyp" && box.end - box.contentStart >= 8) {
      metadata.majorBrand = bytes.toString("latin1", box.contentStart, box.contentStart + 4);
      for (let offset = box.contentStart + 8; offset + 4 <= box.end; offset += 4) {
        brands.push(bytes.toString("latin1", offset, offset + 4));
      }
    }

    if ((box.type === "mvhd" || box.type === "mdhd") && box.end - box.contentStart >= 24) {
      const parsed = parseMp4TimeBox(bytes, box.contentStart, box.end);
      if (parsed.createdAt) creationTimes.push(parsed.createdAt);
      if (parsed.durationSeconds !== undefined) durations.push(parsed.durationSeconds);
      metadata[`${box.type}CreatedAt`] = parsed.createdAt ?? null;
      metadata[`${box.type}DurationSeconds`] = parsed.durationSeconds ?? null;
    }

    if (box.type === "data" && box.path.length >= 2 && box.end - box.contentStart > 8) {
      const key = box.path[box.path.length - 2];
      const raw = bytes.subarray(box.contentStart + 8, box.end);
      const value = raw.toString("utf8").replace(/\0+$/, "").trim();
      if (value) tags[key] = value;
    }
  });

  if (brands.length) metadata.compatibleBrands = brands;
  if (Object.keys(tags).length) metadata.tags = tags;
  const tagDate = tags["©day"] ?? tags.date ?? tags.creationdate ?? tags["com.apple.quicktime.creationdate"];
  metadata.createdAt = validDate(tagDate) ?? creationTimes.find(Boolean) ?? null;
  if (durations.length) metadata.durationSeconds = durations.find((value) => Number.isFinite(value) && value > 0) ?? null;
  return metadata;
}

type Mp4Box = {
  type: string;
  contentStart: number;
  end: number;
  path: string[];
};

function scanMp4Boxes(
  bytes: Buffer,
  start: number,
  end: number,
  path: string[],
  depth: number,
  visit: (box: Mp4Box) => void,
) {
  if (depth > 8) return;
  let offset = start;

  while (offset + 8 <= end) {
    const size32 = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;

    if (size32 === 1) {
      if (offset + 16 > end) break;
      size = Number(bytes.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) break;

    let contentStart = offset + headerSize;
    const boxEnd = offset + size;
    const boxPath = [...path, type];
    const box = { type, contentStart, end: boxEnd, path: boxPath };
    visit(box);

    if (type === "meta" && boxEnd - contentStart >= 4) contentStart += 4;
    if (["moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "ilst"].includes(type)) {
      scanMp4Boxes(bytes, contentStart, boxEnd, boxPath, depth + 1, visit);
    } else if (path.includes("ilst")) {
      scanMp4Boxes(bytes, contentStart, boxEnd, boxPath, depth + 1, visit);
    }

    offset = boxEnd;
  }
}

function parseMp4TimeBox(bytes: Buffer, start: number, end: number) {
  const version = bytes[start];
  const epochOffsetSeconds = Date.UTC(1904, 0, 1) / 1000;

  if (version === 1 && start + 32 <= end) {
    const createdSeconds = Number(bytes.readBigUInt64BE(start + 4));
    const timescale = bytes.readUInt32BE(start + 20);
    const duration = Number(bytes.readBigUInt64BE(start + 24));
    return {
      createdAt: quickTimeDate(createdSeconds, epochOffsetSeconds),
      durationSeconds: timescale ? duration / timescale : undefined,
    };
  }

  if (start + 20 <= end) {
    const createdSeconds = bytes.readUInt32BE(start + 4);
    const timescale = bytes.readUInt32BE(start + 12);
    const duration = bytes.readUInt32BE(start + 16);
    return {
      createdAt: quickTimeDate(createdSeconds, epochOffsetSeconds),
      durationSeconds: timescale ? duration / timescale : undefined,
    };
  }

  return {};
}

function quickTimeDate(seconds: number, epochOffsetSeconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date((seconds + epochOffsetSeconds) * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function validDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function isMp4Like(bytes: Uint8Array) {
  for (let offset = 0; offset + 12 <= Math.min(bytes.length, 4096); ) {
    const size = readUInt32BE(bytes, offset);
    if (size < 8) return false;
    if (startsWithAscii(bytes, offset + 4, "ftyp")) return true;
    offset += size;
  }
  return false;
}

function headersToJson(headers: Headers) {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = redactedHeaderNames.has(key.toLowerCase()) ? "<redacted>" : value;
  }
  return out;
}

function queryToJson(url: URL, redactedKeys = new Set<string>()) {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const sanitizedValue = redactedKeys.has(key) ? "<redacted>" : value;
    const current = out[key];
    if (Array.isArray(current)) current.push(sanitizedValue);
    else if (current !== undefined) out[key] = [current, sanitizedValue];
    else out[key] = sanitizedValue;
  }
  return out;
}

function filenameFromContentDisposition(value: string | null) {
  if (!value) return undefined;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ""));
  const ascii = value.match(/filename="?([^";]+)"?/i);
  return ascii?.[1];
}

function fileExtension(filename?: string) {
  const match = filename?.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1];
}

function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
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
          s.content_sha256,
          s.mime_type,
          s.encoding,
          s.line_count,
          s.mode,
          s.symlink_target,
          s.git_repo_root,
          s.git_branch,
          s.git_commit,
          s.git_dirty,
          s.git_remote_url,
          s.deleted_at,
          count(e.id) as event_count
        from chat_sessions s
        join agents a on a.id = s.agent_id
        join projects p on p.id = s.project_id
        left join session_events e on e.session_db_id = s.id
        where s.agent_id = ${agentId}
          and s.deleted_at is null
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
          s.content_sha256,
          s.mime_type,
          s.encoding,
          s.line_count,
          s.mode,
          s.symlink_target,
          s.git_repo_root,
          s.git_branch,
          s.git_commit,
          s.git_dirty,
          s.git_remote_url,
          s.deleted_at,
          count(e.id) as event_count
        from chat_sessions s
        join agents a on a.id = s.agent_id
        join projects p on p.id = s.project_id
        left join session_events e on e.session_db_id = s.id
        where s.deleted_at is null
        group by s.id, a.hostname, p.project_key, p.display_name
        order by s.last_seen_at desc
      `;

  return rows.map(mapSession);
}

async function getSessionMeta(id: string): Promise<SessionInfo | null> {
  const rows = await sql`
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
      s.content_sha256,
      s.mime_type,
      s.encoding,
      s.line_count,
      s.mode,
      s.symlink_target,
      s.git_repo_root,
      s.git_branch,
      s.git_commit,
      s.git_dirty,
      s.git_remote_url,
      s.deleted_at,
      count(e.id) as event_count
    from chat_sessions s
    join agents a on a.id = s.agent_id
    join projects p on p.id = s.project_id
    left join session_events e on e.session_db_id = s.id
    where s.id = ${id}
    group by s.id, a.hostname, p.project_key, p.display_name
  `;
  return rows.length ? mapSession(rows[0]) : null;
}

async function getSessionsMeta(ids: string[]): Promise<SessionInfo[]> {
  if (!ids.length) return [];
  const results = await Promise.all(ids.map((id) => getSessionMeta(id)));
  return results.filter((s): s is SessionInfo => s !== null);
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
      s.content_sha256,
      s.mime_type,
      s.encoding,
      s.line_count,
      s.mode,
      s.symlink_target,
      s.git_repo_root,
      s.git_branch,
      s.git_commit,
      s.git_dirty,
      s.git_remote_url,
      s.deleted_at,
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
  const limitBytes = clamp(Math.floor(body.limitBytes ?? 2 * 1024 * 1024), 64 * 1024, 16 * 1024 * 1024);
  const cursor = BigInt(body.cursor && /^\d+$/.test(body.cursor) ? body.cursor : "0");
  const fetchLimit = 10000;
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
  const sessions = sessionIds.length ? await getSessionsMeta(sessionIds) : [];

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
    contentSha256: row.content_sha256 ?? null,
    mimeType: row.mime_type ?? null,
    encoding: row.encoding ?? null,
    lineCount: row.line_count == null ? null : toNumber(row.line_count),
    mode: row.mode == null ? null : toNumber(row.mode),
    symlinkTarget: row.symlink_target ?? null,
    gitRepoRoot: row.git_repo_root ?? null,
    gitBranch: row.git_branch ?? null,
    gitCommit: row.git_commit ?? null,
    gitDirty: row.git_dirty ?? null,
    gitRemoteUrl: row.git_remote_url ?? null,
    deletedAt: row.deleted_at ?? null,
  };
}

async function ingestBatch(body: IngestBatchRequest): Promise<IngestBatchResponse> {
  validateBatch(body);

  let acceptedEvents = 0;
  const changedSessionIds = new Set<string>();

  for (const session of body.sessions) {
    const accepted = await sql.transaction(async (tx: any) => {
      await tx`
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

      const projectRows = await tx`
        insert into projects (agent_id, project_key, display_name, last_seen_at)
        values (${body.agent.agentId}, ${session.projectKey}, ${session.projectName ?? shortProject(session.projectKey)}, now())
        on conflict (agent_id, project_key) do update set
          display_name = excluded.display_name,
          last_seen_at = now()
        returning id
      `;
      const projectId = projectRows[0].id;
      const title = session.events.find((event) => event.title)?.title ?? null;
      const file = session.file ?? {};
      const git = session.git ?? {};

      const sessionRows = await tx`
        insert into chat_sessions (
          agent_id,
          project_id,
          session_id,
          source_path,
          title,
          size_bytes,
          mtime_ms,
          last_seen_at,
          content_sha256,
          mime_type,
          encoding,
          line_count,
          mode,
          symlink_target,
          git_repo_root,
          git_branch,
          git_commit,
          git_dirty,
          git_remote_url,
          deleted_at
        )
        values (
          ${body.agent.agentId},
          ${projectId},
          ${session.sessionId},
          ${session.sourcePath},
          ${title},
          ${session.sizeBytes},
          ${session.mtimeMs},
          now(),
          ${file.contentSha256 ?? null},
          ${file.mimeType ?? null},
          ${file.encoding ?? null},
          ${file.lineCount ?? null},
          ${file.mode ?? null},
          ${file.symlinkTarget ?? null},
          ${git.repoRoot ?? null},
          ${git.branch ?? null},
          ${git.commit ?? null},
          ${git.dirty ?? null},
          ${git.remoteUrl ?? null},
          case when ${session.deleted ?? false}::boolean then now() else null end
        )
        on conflict (agent_id, session_id) do update set
          project_id = excluded.project_id,
          source_path = excluded.source_path,
          title = coalesce(excluded.title, chat_sessions.title),
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          last_seen_at = now(),
          content_sha256 = coalesce(excluded.content_sha256, chat_sessions.content_sha256),
          mime_type = coalesce(excluded.mime_type, chat_sessions.mime_type),
          encoding = coalesce(excluded.encoding, chat_sessions.encoding),
          line_count = coalesce(excluded.line_count, chat_sessions.line_count),
          mode = coalesce(excluded.mode, chat_sessions.mode),
          symlink_target = coalesce(excluded.symlink_target, chat_sessions.symlink_target),
          git_repo_root = coalesce(excluded.git_repo_root, chat_sessions.git_repo_root),
          git_branch = coalesce(excluded.git_branch, chat_sessions.git_branch),
          git_commit = coalesce(excluded.git_commit, chat_sessions.git_commit),
          git_dirty = coalesce(excluded.git_dirty, chat_sessions.git_dirty),
          git_remote_url = coalesce(excluded.git_remote_url, chat_sessions.git_remote_url),
          deleted_at = case
            when excluded.deleted_at is not null then excluded.deleted_at
            else chat_sessions.deleted_at
          end
        returning id
      `;
      const sessionDbId = sessionRows[0].id;
      changedSessionIds.add(toId(sessionDbId));

      if (session.deleted) return 0;

      let inserts = 0;
      for (const event of session.events) {
        await tx.unsafe("savepoint sp_event");
        try {
          const inserted = await tx`
            insert into session_events (
              session_db_id,
              agent_id,
              source_line_no,
              source_offset,
              event_type,
              role,
              occurred_at,
              raw,
              line_sha256
            )
            values (
              ${sessionDbId},
              ${body.agent.agentId},
              ${event.lineNo},
              ${event.offset},
              ${event.eventType ?? null},
              ${event.role ?? null},
              ${event.createdAt ?? null},
              ${event.raw}::jsonb,
              ${event.lineSha256 ?? null}
            )
            on conflict (session_db_id, source_line_no) do nothing
            returning id
          `;
          await tx.unsafe("release savepoint sp_event");
          inserts += inserted.length;
        } catch (error) {
          await tx.unsafe("rollback to savepoint sp_event");
          await tx.unsafe("release savepoint sp_event").catch(() => {});
          console.error("ingest event insert failed", {
            sessionDbId: toId(sessionDbId),
            lineNo: event.lineNo,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return inserts;
    });
    acceptedEvents += accepted;
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

function subscribeYjsSocket(ws: YjsWebSocket, docIds: string[]) {
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

function unsubscribeYjsSocket(ws: YjsWebSocket) {
  const docIds = docIdsBySocket.get(ws);
  if (!docIds) return;
  for (const docId of docIds) {
    const sockets = yjsSocketsByDoc.get(docId);
    sockets?.delete(ws);
    if (sockets?.size === 0) yjsSocketsByDoc.delete(docId);
  }
  docIds.clear();
}

function broadcastYjsUpdate(docId: string, update: string, except?: YjsWebSocket) {
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

function readUInt32BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function startsWithAscii(bytes: Uint8Array, offset: number, value: string) {
  if (offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
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
