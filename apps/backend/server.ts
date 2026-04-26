import index from "../../index.html";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import * as Y from "yjs";
import type { ServerWebSocket } from "bun";
import type {
  AppSettingsInfo,
  AppLogBatchRequest,
  AudioTranscriptPayload,
  AudioTranscriptionInfo,
  HostInfo,
  ImportedAudioInfo,
  IngestBatchRequest,
  IngestBatchResponse,
  ImportTokenInfo,
  SessionInfo,
  SessionPayload,
  SyncRequest,
  SyncResponse,
  StreamMessage,
  YjsSocketMessage,
  YjsSyncRequest,
  YjsSyncResponse,
  OpenRouterStatusInfo,
} from "../../packages/shared/types";
import {
  OPENROUTER_REASONING_EFFORTS,
  OPENROUTER_TRANSCRIPTION_MODELS,
  type OpenRouterReasoningEffort,
} from "../../packages/shared/types";
import { downloadAgentArchiveResponse } from "./agent-download";
import { handleClientLogRequest, listAppLogs, logBackendEvent, logBackendRequestEvent } from "./app-logs";
import {
  handleAgentAppend,
  handleAgentHello,
  handleAgentInventory,
  isSyncEngineHttpError,
} from "./sync-engine";
import {
  getV2Session,
  getV2SessionsMeta,
  isV2SessionId,
  listV2EventsForSync,
  listV2Hosts,
  listV2Sessions,
  mapV2EventRow,
  mergeHostLists,
  mergeSessionLists,
  parseV2SessionId,
} from "./v2-read-model";
import { envFlag, envPositiveInteger, envValue } from "../../packages/shared/env";
import { prepareDatabase, sql, toId, toNumber } from "./db";
import { detectMedia, fileExtension, filenameFromContentDisposition } from "./media-detect";
import {
  extractOpenRouterMessageContent,
  normalizeStoredTranscript,
  parseJsonObject,
  parseJsonObjectLoose,
  validateStoredTranscript,
} from "./openrouter-transcript";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(envValue(process.env, "PORT", "CHATVIEW_PORT") ?? 3737);
const agentToken = envValue(process.env, "AGENT_TOKEN", "CHATVIEW_AGENT_TOKEN") ?? (isProduction ? "" : "dev-token");
const webToken = envValue(process.env, "WEB_TOKEN", "CHATVIEW_WEB_TOKEN") ?? "";
const importStoreBody = envFlag(process.env, ["IMPORT_STORE_BODY", "CHATVIEW_IMPORT_STORE_BODY"]);
const openRouterApiKey = envValue(process.env, "OPENROUTER_API_KEY");
const openRouterModel = normalizeTranscriptionModel(envValue(process.env, "OPENROUTER_MODEL"));
const openRouterReasoningEffort = normalizeReasoningEffort(envValue(process.env, "OPENROUTER_REASONING_EFFORT"));
const openRouterEndpoint = envValue(process.env, "OPENROUTER_ENDPOINT") ?? "https://openrouter.ai/api/v1/chat/completions";
const openRouterKeyEndpoint = envValue(process.env, "OPENROUTER_KEY_ENDPOINT") ?? "https://openrouter.ai/api/v1/key";
const ffmpegBin = envValue(process.env, "FFMPEG_BIN") ?? "ffmpeg";
const dataDir = envValue(process.env, "DATA_DIR", "CHATVIEW_DATA_DIR") ?? "";
const legacyIngestEnabled = envFlag(process.env, ["LEGACY_INGEST_ENABLED", "CHATVIEW_LEGACY_INGEST_ENABLED"]);
const transcriptionConcurrency = envPositiveInteger(process.env, ["TRANSCRIPTION_CONCURRENCY"], 2);
const webAuthCookie = "chatview_token";
const webAuthCookieMaxAge = 60 * 60 * 24 * 30;
const gitSha = process.env.GIT_SHA ?? "unknown";
const encoder = new TextEncoder();
const streamClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const redactedHeaderNames = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
const redactedQueryNames = new Set(["token"]);
const transcriptionQueue: string[] = [];
const queuedTranscriptionIds = new Set<string>();
const runningTranscriptionIds = new Set<string>();
let activeTranscriptionJobs = 0;
let openRouterStatus: OpenRouterStatusInfo = initialOpenRouterStatus();
let openRouterStatusCheck: Promise<OpenRouterStatusInfo> | null = null;
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

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("unhandled rejection", message);
  void logBackendEvent({
    level: "error",
    event: "backend.unhandled_rejection",
    message,
    tags: ["backend", "process"],
    context: errorToLogContext(reason),
  });
});

process.on("uncaughtException", (error) => {
  console.error("uncaught exception", error);
  void logBackendEvent({
    level: "fatal",
    event: "backend.uncaught_exception",
    message: error.message,
    tags: ["backend", "process"],
    context: errorToLogContext(error),
  }).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 1000).unref?.();
});

await prepareDatabase();
await prepareDataDir();
void refreshOpenRouterStatus("startup").catch((error) => {
  console.error("OpenRouter startup check failed", error instanceof Error ? error.message : String(error));
});
void backfillMediaBlobStorage().catch((error) => {
  console.error("failed to backfill media blob storage", error instanceof Error ? error.message : String(error));
});
void resumeQueuedTranscriptionJobs().catch((error) => {
  console.error("failed to resume queued transcriptions", error);
});

Bun.serve<{ docIds: Set<string> }>({
  port,
  routes: {
    "/": index,
    "/api/health": () => json({ ok: true, commit_sha: gitSha }),
    "/api/auth/status": (req: Request) => {
      const authenticated = isWebAuthorized(req);
      void logBackendRequestEvent(
        {
          level: "debug",
          event: "auth.status",
          tags: ["auth", "request"],
          context: {
            configured: Boolean(webToken),
            authenticated,
          },
        },
        req,
      );
      return json({ configured: Boolean(webToken), authenticated });
    },
    "/api/auth/login": async (req: Request) => {
      if (req.method !== "POST") return text("method not allowed", 405);
      if (!webToken) return text("auth token is not configured", 503);

      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      if (!tokenMatches(typeof body.token === "string" ? body.token : "", webToken)) {
        void logBackendRequestEvent(
          {
            level: "warn",
            event: "auth.login_failed",
            message: "invalid web token",
            tags: ["auth", "request"],
            context: { configured: Boolean(webToken) },
          },
          req,
        );
        return text("unauthorized", 401);
      }

      void logBackendRequestEvent(
        {
          level: "info",
          event: "auth.login_succeeded",
          tags: ["auth", "request"],
          context: { configured: Boolean(webToken) },
        },
        req,
      );
      return json({ ok: true }, 200, { "set-cookie": makeWebAuthCookie(req, webToken) });
    },
    "/api/auth/logout": (req: Request) => json({ ok: true }, 200, { "set-cookie": clearWebAuthCookie(req) }),
    "/status-9c8e0f3a2b71": () => json({ ok: true, commit_sha: gitSha, uptime: Math.round(process.uptime()) }),
    "/api/hosts": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      return json(await listReadableHosts());
    },
    "/api/sessions": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      const url = new URL(req.url);
      return json(await listReadableSessions(url.searchParams.get("agentId") ?? undefined));
    },
    "/api/v2/hosts": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      return json(await listReadableHosts());
    },
    "/api/v2/sessions": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      const url = new URL(req.url);
      return json(await listReadableSessions(url.searchParams.get("agentId") ?? undefined));
    },
    "/api/v2/sessions/:id/events": async (req: Request & { params?: { id?: string } }) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      const fallbackId = new URL(req.url).pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/events$/)?.[1];
      const id = decodeURIComponent(req.params?.id ?? fallbackId ?? "");
      if (!id) return text("missing id", 400);
      const payload = await getReadableSession(id);
      return payload ? json(payload) : text("session not found", 404);
    },
    "/api/session": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      if (!id) return text("missing id", 400);
      const payload = await getReadableSession(id);
      return payload ? json(payload) : text("session not found", 404);
    },
    "/api/sync": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method !== "POST") return text("method not allowed", 405);
      const started = performance.now();
      const body = (await req.json().catch(() => ({}))) as SyncRequest;
      try {
        const result = await sync(body);
        const durationMs = Math.round(performance.now() - started);
        if (result.hasMore || durationMs > 1000) {
          void logBackendRequestEvent({
            level: "info",
            event: "sync.batch",
            message: "served sync batch",
            tags: ["sync"],
            context: {
              durationMs,
              cursor: body.cursor ?? null,
              nextCursor: result.cursor,
              limitBytes: body.limitBytes ?? null,
              metadataOnly: body.metadataOnly === true,
              hosts: result.hosts.length,
              sessions: result.sessions.length,
              events: result.events.length,
              approxBytes: result.approxBytes,
              hasMore: result.hasMore,
            },
          }, req);
        }
        return json(result);
      } catch (error) {
        void logBackendRequestEvent({
          level: "error",
          event: "sync.failed",
          message: error instanceof Error ? error.message : String(error),
          tags: ["sync"],
          context: {
            body,
            durationMs: Math.round(performance.now() - started),
            error: errorToLogContext(error),
          },
        }, req);
        return text(error instanceof Error ? error.message : "sync failed", 500);
      }
    },
    "/api/app/logs": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method === "GET") return json(await listAppLogs(req));
      if (req.method !== "POST") return text("method not allowed", 405);
      const body = (await req.json().catch(() => ({}))) as AppLogBatchRequest;
      return json(await handleClientLogRequest(req, body));
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
    "/api/agent/v1/hello": async (req: Request) => handleAgentV1(req, () => handleAgentHello(req, sql)),
    "/api/agent/v1/inventory": async (req: Request) => handleAgentV1(req, () => handleAgentInventory(req, sql)),
    "/api/agent/v1/append": async (req: Request) => handleAgentV1(req, () => handleAgentAppend(req, sql)),
    "/api/app/settings": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      return json(await getAppSettings(req));
    },
    "/api/app/openrouter/check": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method !== "POST") return text("method not allowed", 405);
      return json(await refreshOpenRouterStatus("manual", true));
    },
    "/api/imports/tokens": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method !== "POST") return text("method not allowed", 405);
      const body = (await req.json().catch(() => ({}))) as { label?: unknown };
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "iPhone Shortcut";
      return json(await createImportToken(req, label), 201);
    },
    "/api/imports/audio": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method === "GET") return json(await listImportedAudio());
      if (req.method === "DELETE") return deleteImportedAudio(req);
      return text("method not allowed", 405);
    },
    "/api/imports/audio/upload": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method !== "POST") return text("method not allowed", 405);
      return handleAuthenticatedAudioUpload(req);
    },
    "/api/imports/audio/transcriptions": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method !== "POST") return text("method not allowed", 405);
      try {
        const body = (await req.json().catch(() => ({}))) as {
          mediaId?: unknown;
          model?: unknown;
          reasoningEffort?: unknown;
        };
        if (typeof body.mediaId !== "string" && typeof body.mediaId !== "number") return text("missing mediaId", 400);
        const transcription = await createAudioTranscription(String(body.mediaId), "manual", {
          model: requestedTranscriptionModel(body.model),
          reasoningEffort: requestedReasoningEffort(body.reasoningEffort),
        });
        enqueueAudioTranscription(transcription.id);
        return json(transcription, 202);
      } catch (error) {
        return text(error instanceof Error ? error.message : "could not queue transcription", 400);
      }
    },
    "/api/imports/media/file": async (req: Request) => {
      const auth = requireWebAuth(req);
      if (auth) return auth;
      if (req.method !== "GET") return text("method not allowed", 405);
      return getImportedMediaFile(req);
    },
    "/api/ingest/batch": async (req: Request) => {
      if (req.method !== "POST") return text("method not allowed", 405);
      if (!isAuthorized(req)) return text("unauthorized", 401);
      if (!legacyIngestEnabled) return text("legacy ingest disabled", 410);
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

async function handleAgentV1(req: Request, handler: () => Promise<unknown>) {
  if (req.method !== "POST") return text("method not allowed", 405);
  if (!isAuthorized(req)) return text("unauthorized", 401);

  try {
    return json(await handler());
  } catch (error) {
    const message = error instanceof Error ? error.message : "bad request";
    const status = isSyncEngineHttpError(error) ? error.status : 500;
    return text(message, status);
  }
}

function errorToLogContext(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: String(error) };
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

function initialOpenRouterStatus(): OpenRouterStatusInfo {
  return {
    configured: Boolean(openRouterApiKey),
    status: openRouterApiKey ? "checking" : "missing",
    model: openRouterModel,
    reasoningEffort: openRouterReasoningEffort,
    endpoint: openRouterEndpoint,
    keyEndpoint: openRouterKeyEndpoint,
    checkedAt: null,
    message: openRouterApiKey ? "OpenRouter check has not completed yet" : "OPENROUTER_API_KEY is not configured",
    key: null,
  };
}

async function refreshOpenRouterStatus(source: "startup" | "manual", force = false): Promise<OpenRouterStatusInfo> {
  if (openRouterStatusCheck && !force) return openRouterStatusCheck;

  openRouterStatus = {
    ...openRouterStatus,
    configured: Boolean(openRouterApiKey),
    status: openRouterApiKey ? "checking" : "missing",
    checkedAt: new Date().toISOString(),
    message: openRouterApiKey ? "Checking OpenRouter key" : "OPENROUTER_API_KEY is not configured",
    key: openRouterApiKey ? openRouterStatus.key ?? null : null,
  };

  if (!openRouterApiKey) {
    console.warn("OpenRouter is disabled: OPENROUTER_API_KEY is not configured");
    return openRouterStatus;
  }

  openRouterStatusCheck = checkOpenRouterKey()
    .then((status) => {
      openRouterStatus = status;
      const remaining = status.key?.limitRemaining;
      const remainingText = typeof remaining === "number" ? `, limit remaining ${remaining}` : "";
      console.log(`OpenRouter ${source} check ok${remainingText}`);
      return openRouterStatus;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      openRouterStatus = {
        ...openRouterStatus,
        configured: true,
        status: "error",
        checkedAt: new Date().toISOString(),
        message,
      };
      console.warn(`OpenRouter ${source} check failed: ${message}`);
      return openRouterStatus;
    })
    .finally(() => {
      openRouterStatusCheck = null;
    });

  return openRouterStatusCheck;
}

async function checkOpenRouterKey(): Promise<OpenRouterStatusInfo> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(openRouterKeyEndpoint, {
      method: "GET",
      headers: {
        authorization: `Bearer ${openRouterApiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const responseJson = parseJsonObject(bodyText) ?? {};

    if (!response.ok) {
      throw new Error(`OpenRouter key check failed (${response.status}): ${openRouterErrorMessage(responseJson, bodyText)}`);
    }

    const key = normalizeOpenRouterKeyInfo(responseJson);
    if (typeof key.limitRemaining === "number" && key.limitRemaining <= 0) {
      throw new Error("OpenRouter key has no remaining credit limit");
    }

    return {
      configured: true,
      status: "ok",
      model: openRouterModel,
      reasoningEffort: openRouterReasoningEffort,
      endpoint: openRouterEndpoint,
      keyEndpoint: openRouterKeyEndpoint,
      checkedAt: new Date().toISOString(),
      message: "OpenRouter key is valid",
      key,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("OpenRouter key check timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOpenRouterKeyInfo(responseJson: any): NonNullable<OpenRouterStatusInfo["key"]> {
  const data = responseJson?.data && typeof responseJson.data === "object" ? responseJson.data : {};
  const rateLimit = data.rate_limit && typeof data.rate_limit === "object" ? data.rate_limit : null;
  return {
    label: typeof data.label === "string" ? data.label : null,
    limit: numberOrNull(data.limit),
    usage: numberOrNull(data.usage),
    limitRemaining: numberOrNull(data.limit_remaining),
    isFreeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
    rateLimit: rateLimit
      ? {
          requests: numberOrNull(rateLimit.requests),
          interval: typeof rateLimit.interval === "string" ? rateLimit.interval : null,
        }
      : null,
  };
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requestOrigin(req: Request) {
  const url = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = forwardedProto || url.protocol.replace(/:$/, "");
  const host = forwardedHost || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

function makeImportUrl(origin: string, path: string, token: string) {
  const url = new URL(path, origin);
  url.searchParams.set("token", token);
  return url.toString();
}

function tokenPreview(token: string) {
  return token.length <= 10 ? token : `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function getAppSettings(req: Request): Promise<AppSettingsInfo> {
  const origin = requestOrigin(req);
  const rows = await sql`
    select id, token, label, created_at, last_used_at
    from import_tokens
    order by created_at desc
  `;

  return {
    origin,
    importUploadPath: "/api/imports/media",
    shortcutUploadPath: "/api/shortcuts/audio",
    importTokens: rows.map((row: any): ImportTokenInfo => ({
      id: toId(row.id),
      label: row.label,
      tokenPreview: tokenPreview(row.token),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
      uploadUrl: makeImportUrl(origin, "/api/imports/media", row.token),
      shortcutUrl: makeImportUrl(origin, "/api/shortcuts/audio", row.token),
    })),
    openRouter: openRouterStatus,
    transcriptionModels: [...OPENROUTER_TRANSCRIPTION_MODELS],
    reasoningEfforts: [...OPENROUTER_REASONING_EFFORTS],
  };
}

async function createImportToken(req: Request, label: string): Promise<ImportTokenInfo> {
  const token = `im_${randomBytes(24).toString("base64url")}`;
  const rows = await sql`
    insert into import_tokens (token, label)
    values (${token}, ${label})
    returning id, token, label, created_at, last_used_at
  `;
  const row = rows[0];
  const origin = requestOrigin(req);
  return {
    id: toId(row.id),
    label: row.label,
    tokenPreview: tokenPreview(row.token),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    uploadUrl: makeImportUrl(origin, "/api/imports/media", row.token),
    shortcutUrl: makeImportUrl(origin, "/api/shortcuts/audio", row.token),
  };
}

async function listImportedAudio(): Promise<ImportedAudioInfo[]> {
  const rows = await sql`
    select
      m.id,
      m.sha256,
      m.size_bytes,
      m.content_type,
      m.filename,
      m.detected_format,
      m.metadata,
      m.created_at,
      m.last_seen_at,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', t.id::text,
            'status', t.status,
            'source', t.source,
            'model', t.model,
            'reasoningEffort', t.reasoning_effort,
            'transcript', nullif(t.transcript, '{}'::jsonb),
            'error', t.error,
            'createdAt', t.created_at,
            'startedAt', t.started_at,
            'completedAt', t.completed_at
          )
          order by t.created_at desc
        ) filter (where t.id is not null),
        '[]'::jsonb
      ) as transcriptions
    from import_media_blobs m
    left join import_media_transcriptions t on t.media_id = m.id
    where m.media_kind = 'audio'
    group by m.id
    order by m.last_seen_at desc
    limit 100
  `;

  return rows.map((row: any): ImportedAudioInfo => ({
    id: toId(row.id),
    sha256: row.sha256,
    sizeBytes: toNumber(row.size_bytes),
    contentType: row.content_type ?? null,
    filename: row.filename ?? null,
    detectedFormat: row.detected_format ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    durationSeconds: typeof row.metadata?.durationSeconds === "number" ? row.metadata.durationSeconds : null,
    transcriptions: Array.isArray(row.transcriptions)
      ? row.transcriptions.map(mapAudioTranscription)
      : [],
  }));
}

function mapAudioTranscription(row: any): AudioTranscriptionInfo {
  return {
    id: toId(row.id),
    status: ["queued", "processing", "completed", "failed"].includes(row.status) ? row.status : "failed",
    source: row.source,
    model: row.model,
    reasoningEffort: row.reasoningEffort ?? row.reasoning_effort ?? "medium",
    transcript: normalizeStoredTranscript(row.transcript),
    error: row.error ?? null,
    createdAt: row.createdAt ?? row.created_at,
    startedAt: row.startedAt ?? row.started_at ?? null,
    completedAt: row.completedAt ?? row.completed_at ?? null,
  };
}

async function getImportedMediaFile(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return text("missing id", 400);

  const rows = await sql`
    select bytes, storage_key, content_type, filename
    from import_media_blobs
    where id = ${id}
      and media_kind = 'audio'
  `;
  if (!rows.length) return text("media not found", 404);

  const row = rows[0];
  const bytes = await loadStoredBlob(row);
  const headers = new Headers({
    "content-type": row.content_type || "application/octet-stream",
    "cache-control": "private, max-age=3600",
  });
  if (row.filename) headers.set("content-disposition", `inline; filename="${String(row.filename).replace(/"/g, "")}"`);
  return new Response(bytes, { headers });
}

async function handleAuthenticatedAudioUpload(req: Request) {
  const url = new URL(req.url);
  const rawBody = Buffer.from(await req.clone().arrayBuffer());
  const requestId = await createImportRequestLog(req, url, rawBody, null, null);

  try {
    const result = await ingestImportMedia(req, rawBody, requestId);
    return finishImportResponse(requestId, { ok: true, requestId, ...result }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "audio upload failed";
    void logBackendEvent({
      level: "error",
      event: "audio.upload_failed",
      message,
      tags: ["audio", "upload"],
      context: { requestId: toId(requestId), error: errorToLogContext(error) },
    });
    return finishImportResponse(requestId, { ok: false, requestId, error: message }, 500);
  }
}

async function deleteImportedAudio(req: Request) {
  const url = new URL(req.url);
  let mediaId: unknown = url.searchParams.get("id") ?? url.searchParams.get("mediaId");
  if (!mediaId) {
    const body = (await req.json().catch(() => ({}))) as { id?: unknown; mediaId?: unknown };
    mediaId = body.mediaId ?? body.id;
  }
  if (typeof mediaId !== "string" && typeof mediaId !== "number") return text("missing mediaId", 400);

  const rows = await sql`
    delete from import_media_blobs
    where id = ${String(mediaId)}
      and media_kind = 'audio'
    returning id, storage_key
  `;
  if (!rows.length) return text("audio media not found", 404);
  if (rows[0].storage_key) void deleteStoredBlob(rows[0].storage_key).catch((error) => console.error(error));
  return json({ ok: true, mediaId: toId(rows[0].id) });
}

async function ensureAutoAudioTranscription(mediaId: string): Promise<AudioTranscriptionInfo | null> {
  const existing = await sql`
    select id
    from import_media_transcriptions
    where media_id = ${mediaId}
      and source = 'auto'
      and status in ('queued', 'processing', 'completed')
    limit 1
  `;
  if (existing.length) return null;
  return createAudioTranscription(mediaId, "auto");
}

async function createAudioTranscription(
  mediaId: string,
  source: "auto" | "manual",
  options: { model?: string; reasoningEffort?: string } = {},
): Promise<AudioTranscriptionInfo> {
  const model = requestedTranscriptionModel(options.model);
  const reasoningEffort = requestedReasoningEffort(options.reasoningEffort);
  const mediaRows = await sql`
    select id
    from import_media_blobs
    where id = ${mediaId}
      and media_kind = 'audio'
  `;
  if (!mediaRows.length) throw new Error("audio media not found");

  const rows = await sql`
    insert into import_media_transcriptions (
      media_id,
      source,
      status,
      model,
      reasoning_effort
    )
    values (
      ${mediaId},
      ${source},
      'queued',
      ${model},
      ${reasoningEffort}
    )
    returning id, status, source, model, reasoning_effort, transcript, error, created_at, started_at, completed_at
  `;
  return mapAudioTranscription(rows[0]);
}

function enqueueAudioTranscription(transcriptionId: string) {
  if (queuedTranscriptionIds.has(transcriptionId) || runningTranscriptionIds.has(transcriptionId)) return;
  queuedTranscriptionIds.add(transcriptionId);
  transcriptionQueue.push(transcriptionId);
  drainTranscriptionQueue();
}

function drainTranscriptionQueue() {
  while (activeTranscriptionJobs < transcriptionConcurrency && transcriptionQueue.length) {
    const transcriptionId = transcriptionQueue.shift();
    if (!transcriptionId) return;
    queuedTranscriptionIds.delete(transcriptionId);
    if (runningTranscriptionIds.has(transcriptionId)) continue;

    activeTranscriptionJobs += 1;
    runningTranscriptionIds.add(transcriptionId);
    void processAudioTranscription(transcriptionId)
      .catch((error) => {
        console.error("audio transcription failed", {
          transcriptionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        runningTranscriptionIds.delete(transcriptionId);
        activeTranscriptionJobs -= 1;
        drainTranscriptionQueue();
      });
  }
}

async function resumeQueuedTranscriptionJobs() {
  await sql`
    update import_media_transcriptions
    set status = 'queued',
        updated_at = now()
    where status = 'processing'
  `;
  const rows = await sql`
    select id
    from import_media_transcriptions
    where status = 'queued'
    order by created_at asc
    limit 100
  `;
  for (const row of rows) enqueueAudioTranscription(toId(row.id));
}

async function processAudioTranscription(transcriptionId: string) {
  const rows = await sql`
    select
      t.id,
      t.media_id,
      t.model,
      t.reasoning_effort,
      m.bytes,
      m.storage_key,
      m.content_type,
      m.filename,
      m.detected_format
    from import_media_transcriptions t
    join import_media_blobs m on m.id = t.media_id
    where t.id = ${transcriptionId}
      and t.status in ('queued', 'processing')
  `;
  if (!rows.length) return;

  const row = rows[0];
  await sql`
    update import_media_transcriptions
    set status = 'processing',
        started_at = coalesce(started_at, now()),
        updated_at = now(),
        error = null
    where id = ${transcriptionId}
  `;

  try {
    if (!openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not configured");

    const originalBytes = await loadStoredBlob(row);
    const mp3 = await convertAudioToMp3(originalBytes, row.filename, row.detected_format);
    const transcript = await transcribeWithOpenRouter({
      mediaId: toId(row.media_id),
      transcriptionId,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      mp3,
    });

    await sql`
      update import_media_transcriptions
      set status = 'completed',
          source_format = ${row.detected_format ?? row.content_type ?? null},
          mp3_sha256 = ${sha256Hex(mp3)},
          mp3_bytes = ${mp3.length},
          detected_language = ${transcript.detectedLanguage ?? null},
          transcript = ${transcript}::jsonb,
          error = null,
          completed_at = now(),
          updated_at = now()
      where id = ${transcriptionId}
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update import_media_transcriptions
      set status = 'failed',
          error = ${message},
          completed_at = now(),
          updated_at = now()
      where id = ${transcriptionId}
    `;
    void logBackendEvent({
      level: "error",
      event: "audio.transcription_failed",
      message,
      tags: ["audio", "transcription"],
      context: {
        transcriptionId,
        mediaId: toId(row.media_id),
        model: row.model,
        reasoningEffort: row.reasoning_effort,
        error: errorToLogContext(error),
      },
    });
  }
}

async function convertAudioToMp3(bytes: Buffer, filename?: string | null, detectedFormat?: string | null) {
  const dir = await mkdtemp(join(tmpdir(), "chatview-audio-"));
  const extension = fileExtension(filename ?? undefined) ?? formatToExtension(detectedFormat) ?? "audio";
  const inputPath = join(dir, `input.${extension}`);
  const outputPath = join(dir, "output.mp3");

  try {
    await writeFile(inputPath, bytes);
    const proc = Bun.spawn([
      ffmpegBin,
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "32k",
      "-f",
      "mp3",
      outputPath,
    ], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`ffmpeg failed (${exitCode}): ${truncateForLog(stderr, 1200)}`);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function formatToExtension(format?: string | null) {
  if (!format) return undefined;
  const lower = format.toLowerCase();
  if (lower.includes("mp3")) return "mp3";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("caf")) return "caf";
  if (lower.includes("quicktime")) return "mov";
  if (lower.includes("m4a") || lower.includes("mp4")) return "m4a";
  if (lower.includes("aac")) return "aac";
  return undefined;
}

type OpenRouterTranscriptionRequest = {
  mediaId: string;
  transcriptionId: string;
  model: string;
  reasoningEffort: string;
  mp3: Buffer;
};

async function transcribeWithOpenRouter(input: OpenRouterTranscriptionRequest): Promise<AudioTranscriptPayload> {
  const prompt = [
    "Transcribe the attached audio. If you cannot access or hear the audio, return JSON with error: \"AUDIO_NOT_AVAILABLE\".",
    "Return only valid JSON. Do not invent example text.",
    "First produce ru.literal from the audio. Derive ru.clean, ru.summary, ru.brief, and all English fields strictly from ru.literal.",
    "Do not add facts, people, tasks, dates, places, or events that are not present in the literal transcript.",
    "Use [inaudible] for uncertain spans.",
    "Remove filler sounds and hesitation markers such as э, ээ, бэ, мэ, um, uh.",
    "The JSON shape must be:",
    JSON.stringify({
      detectedLanguage: "ru",
      detectedLanguageName: "Russian",
      ru: {
        literal: "very close transcript without filler sounds",
        clean: "shorter clean sentences preserving the substance",
        summary: "detailed clear summary in a reasonably formal style",
        brief: "one short sentence for UI preview",
      },
      en: {
        literal: "very close English translation without filler sounds",
        clean: "shorter clean English sentences preserving the substance",
        summary: "detailed clear English summary in a reasonably formal style",
        brief: "one short English sentence for UI preview",
      },
    }),
  ].join("\n");

  const requestJson = {
    model: input.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "input_audio",
            input_audio: {
              data: input.mp3.toString("base64"),
              format: "mp3",
            },
          },
        ],
      },
    ],
    reasoning: { effort: normalizeReasoningEffort(input.reasoningEffort), exclude: true },
    response_format: { type: "json_object" },
    stream: false,
    temperature: 0,
  };

  const logRequestJson = redactAudioFromOpenRouterRequest(requestJson, input.mp3);
  const logRows = await sql`
    insert into openrouter_call_logs (
      media_id,
      transcription_id,
      model,
      endpoint,
      request_json
    )
    values (
      ${input.mediaId},
      ${input.transcriptionId},
      ${input.model},
      ${openRouterEndpoint},
      ${logRequestJson}::jsonb
    )
    returning id
  `;
  const logId = logRows[0].id;
  const started = performance.now();

  try {
    const response = await fetch(openRouterEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${openRouterApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestJson),
    });
    const bodyText = await response.text();
    const responseJson = parseJsonObject(bodyText) ?? { raw: truncateForLog(bodyText, 20000) };
    const durationMs = Math.round(performance.now() - started);

    await sql`
      update openrouter_call_logs
      set response_status = ${response.status},
          response_json = ${responseJson}::jsonb,
          error = ${response.ok ? null : openRouterErrorMessage(responseJson, bodyText)},
          duration_ms = ${durationMs},
          completed_at = now()
      where id = ${logId}
    `;

    if (!response.ok) throw new Error(`OpenRouter failed (${response.status}): ${openRouterErrorMessage(responseJson, bodyText)}`);
    assertOpenRouterProcessedAudio(responseJson);
    const messageContent = extractOpenRouterMessageContent(responseJson);
    if (!messageContent) throw new Error("OpenRouter returned no message content");
    if (messageContent.includes("AUDIO_NOT_AVAILABLE")) throw new Error("OpenRouter did not receive or process the audio input");
    const transcript = normalizeStoredTranscript(parseJsonObjectLoose(messageContent) ?? messageContent);
    validateStoredTranscript(transcript);
    return transcript;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update openrouter_call_logs
      set error = ${message},
          duration_ms = ${Math.round(performance.now() - started)},
          completed_at = now()
      where id = ${logId}
    `;
    throw error;
  }
}

function normalizeTranscriptionModel(value?: string | null): string {
  return OPENROUTER_TRANSCRIPTION_MODELS.some((model) => model.id === value)
    ? String(value)
    : "google/gemini-3-flash-preview";
}

function requestedTranscriptionModel(value: unknown) {
  if (value === undefined || value === null || value === "") return openRouterModel;
  if (typeof value !== "string") throw new Error("model must be a string");
  const model = value.trim();
  if (OPENROUTER_TRANSCRIPTION_MODELS.some((option) => option.id === model)) return model;
  throw new Error("unsupported transcription model");
}

function normalizeReasoningEffort(value?: string | null): OpenRouterReasoningEffort {
  return OPENROUTER_REASONING_EFFORTS.includes(value as OpenRouterReasoningEffort)
    ? (value as OpenRouterReasoningEffort)
    : "medium";
}

function requestedReasoningEffort(value: unknown): OpenRouterReasoningEffort {
  if (value === undefined || value === null || value === "") return openRouterReasoningEffort;
  if (typeof value !== "string") throw new Error("reasoningEffort must be a string");
  const effort = value.trim();
  if (OPENROUTER_REASONING_EFFORTS.includes(effort as OpenRouterReasoningEffort)) return effort as OpenRouterReasoningEffort;
  throw new Error("reasoningEffort must be low, medium, or high");
}

function assertOpenRouterProcessedAudio(responseJson: any) {
  const audioTokens = responseJson?.usage?.prompt_tokens_details?.audio_tokens;
  if (typeof audioTokens === "number" && audioTokens <= 0) {
    throw new Error("OpenRouter reported zero audio tokens; audio input was not processed");
  }
}

function redactAudioFromOpenRouterRequest(requestJson: any, mp3: Buffer) {
  return {
    ...requestJson,
    messages: requestJson.messages.map((message: any) => ({
      ...message,
      content: message.content.map((part: any) =>
        part.type === "input_audio"
          ? {
              type: "input_audio",
              input_audio: {
                data: "<redacted audio base64>",
                format: part.input_audio?.format ?? part.inputAudio?.format ?? "mp3",
                sha256: sha256Hex(mp3),
                bytes: mp3.length,
              },
            }
          : part,
      ),
    })),
  };
}

function openRouterErrorMessage(responseJson: any, fallback: string) {
  const message = responseJson?.error?.message ?? responseJson?.message;
  return typeof message === "string" ? message : truncateForLog(fallback, 1200);
}

function truncateForLog(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
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

type ImportRequestPartLog = {
  sourceKind: string;
  partIndex: number;
  partName?: string;
  filename?: string;
  contentType?: string;
  sizeBytes: number;
  valueSha256?: string;
  valueText?: string;
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
    void logBackendEvent({
      level: "error",
      event: "import.ingest_failed",
      message,
      tags: ["import"],
      context: { requestId: toId(requestId), error: errorToLogContext(error) },
    });
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
  const { candidates, parts } = await extractImportMediaCandidates(req, rawBody);
  await saveImportRequestParts(requestId, parts);
  const savedMedia = [];

  for (const candidate of candidates) {
    const detection = detectMedia(candidate.bytes, candidate.contentType, candidate.filename);
    if (!detection) continue;

    const metadata = {
      ...candidate.metadata,
      ...detection.metadata,
    };
    const mediaSha256 = sha256Hex(candidate.bytes);
    const storage = await storeBlob("import-media", mediaSha256, candidate.bytes);
    const mediaRows = await sql`
      insert into import_media_blobs (
        media_kind,
        sha256,
        bytes,
        storage_key,
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
        ${mediaSha256},
        ${storage.dbBytes},
        ${storage.storageKey},
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
        bytes = coalesce(import_media_blobs.bytes, excluded.bytes),
        storage_key = coalesce(import_media_blobs.storage_key, excluded.storage_key),
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

    const transcription = await ensureAutoAudioTranscription(toId(media.id));
    if (transcription) enqueueAudioTranscription(transcription.id);
  }

  return {
    rawRequestBytes: rawBody.length,
    parts: parts.length,
    candidates: candidates.length,
    mediaFiles: savedMedia.length,
    media: savedMedia,
    audioFiles: savedMedia.length,
    audio: savedMedia,
  };
}

async function saveImportRequestParts(requestId: unknown, parts: ImportRequestPartLog[]) {
  for (const part of parts) {
    await sql`
      insert into import_request_parts (
        request_id,
        part_index,
        part_name,
        source_kind,
        filename,
        content_type,
        size_bytes,
        value_sha256,
        value_text,
        metadata
      )
      values (
        ${requestId},
        ${part.partIndex},
        ${part.partName ?? null},
        ${part.sourceKind},
        ${part.filename ?? null},
        ${part.contentType ?? null},
        ${part.sizeBytes},
        ${part.valueSha256 ?? null},
        ${part.valueText ?? null},
        ${part.metadata}::jsonb
      )
    `;
  }
}

async function extractImportMediaCandidates(
  req: Request,
  rawBody: Buffer,
): Promise<{ candidates: ImportMediaCandidate[]; parts: ImportRequestPartLog[] }> {
  const contentType = req.headers.get("content-type") ?? "";
  const candidates: ImportMediaCandidate[] = [];
  const parts: ImportRequestPartLog[] = [];

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const form = await req.formData();
    let index = 0;

    for (const [name, value] of form.entries()) {
      if (isUploadedFile(value)) {
        const bytes = Buffer.from(await value.arrayBuffer());
        const metadata = {
          formField: name,
          fileLastModifiedMs: value.lastModified || null,
          fileLastModifiedAt: value.lastModified ? new Date(value.lastModified).toISOString() : null,
        };
        parts.push({
          sourceKind: "multipart-file",
          partIndex: index,
          partName: name,
          filename: value.name || undefined,
          contentType: value.type || undefined,
          sizeBytes: bytes.length,
          valueSha256: sha256Hex(bytes),
          metadata,
        });
        candidates.push({
          sourceKind: "multipart-file",
          partIndex: index,
          partName: name,
          filename: value.name || undefined,
          contentType: value.type || undefined,
          bytes,
          metadata,
        });
      } else {
        const bytes = Buffer.from(value, "utf8");
        parts.push({
          sourceKind: "multipart-field",
          partIndex: index,
          partName: name,
          sizeBytes: bytes.length,
          valueSha256: sha256Hex(bytes),
          valueText: truncateForLog(value, 20000),
          metadata: {
            formField: name,
            truncated: value.length > 20000,
          },
        });
        pushBase64MediaCandidates(candidates, value, {
          sourceKind: "multipart-field-base64",
          partIndex: index,
          partName: name,
          metadata: { formField: name },
        });
      }
      index += 1;
    }

    if (!parts.length) {
      parts.push({
        sourceKind: "multipart-empty",
        partIndex: 0,
        contentType: contentType || undefined,
        sizeBytes: rawBody.length,
        valueSha256: sha256Hex(rawBody),
        metadata: { note: "multipart parser returned no entries" },
      });
    }

    return { candidates, parts };
  }

  if (contentType.toLowerCase().includes("json")) {
    try {
      const parsed = JSON.parse(rawBody.toString("utf8"));
      const jsonText = JSON.stringify(parsed);
      parts.push({
        sourceKind: "json-body",
        partIndex: 0,
        contentType: contentType || undefined,
        sizeBytes: rawBody.length,
        valueSha256: sha256Hex(rawBody),
        valueText: truncateForLog(jsonText, 20000),
        metadata: { truncated: jsonText.length > 20000 },
      });
      pushJsonFieldParts(parts, parsed);
      pushJsonMediaCandidates(candidates, parsed);
      if (candidates.length || parts.length) return { candidates, parts };
    } catch {
      // Keep the body hash for audit purposes and fall back to raw media detection below.
    }
  }

  parts.push({
    sourceKind: "raw-body",
    partIndex: 0,
    filename: filenameFromContentDisposition(req.headers.get("content-disposition")),
    contentType: contentType || undefined,
    sizeBytes: rawBody.length,
    valueSha256: sha256Hex(rawBody),
    valueText: isLikelyText(contentType) ? truncateForLog(rawBody.toString("utf8"), 20000) : undefined,
    metadata: { truncated: isLikelyText(contentType) && rawBody.length > 20000 },
  });
  candidates.push({
    sourceKind: "raw-body",
    partIndex: 0,
    filename: filenameFromContentDisposition(req.headers.get("content-disposition")),
    contentType: contentType || undefined,
    bytes: rawBody,
    metadata: {},
  });
  return { candidates, parts };
}

function isUploadedFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as File).arrayBuffer === "function" &&
    typeof (value as File).name === "string"
  );
}

function pushJsonFieldParts(parts: ImportRequestPartLog[], value: unknown, path: string[] = [], depth = 0) {
  if (depth > 12 || parts.length >= 100) return;

  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    const valueText = String(value);
    const bytes = Buffer.from(valueText, "utf8");
    parts.push({
      sourceKind: "json-field",
      partIndex: parts.length,
      partName: path.join(".") || "$",
      sizeBytes: bytes.length,
      valueSha256: sha256Hex(bytes),
      valueText: truncateForLog(valueText, 20000),
      metadata: {
        jsonPath: path.join(".") || "$",
        valueType: value === null ? "null" : typeof value,
        truncated: valueText.length > 20000,
      },
    });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => pushJsonFieldParts(parts, item, [...path, String(index)], depth + 1));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      pushJsonFieldParts(parts, item, [...path, key], depth + 1);
    }
  }
}

function isLikelyText(contentType: string) {
  const lower = contentType.toLowerCase();
  return lower.startsWith("text/") || lower.includes("json") || lower.includes("xml") || lower.includes("x-www-form-urlencoded");
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

function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listReadableHosts(): Promise<HostInfo[]> {
  const [legacyHosts, v2Hosts] = await Promise.all([listHosts(), listV2Hosts(sql)]);
  return mergeHostLists(legacyHosts, v2Hosts);
}

async function listReadableSessions(agentId?: string): Promise<SessionInfo[]> {
  const [legacySessions, v2Sessions] = await Promise.all([listSessions(agentId), listV2Sessions(sql, agentId)]);
  return mergeSessionLists(legacySessions, v2Sessions);
}

async function getReadableSession(id: string): Promise<SessionPayload | null> {
  if (isV2SessionId(id)) return getV2Session(sql, id);
  return getSession(id);
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

async function getSessionsMeta(ids: string[]): Promise<SessionInfo[]> {
  const uniqueIds = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
  if (!uniqueIds.length) return [];
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
    where s.id = any(${postgresBigintArrayLiteral(uniqueIds)}::bigint[])
    group by s.id, a.hostname, p.project_key, p.display_name
  `;
  const byId = new Map(rows.map((row: any) => [toId(row.id), mapSession(row)] as const));
  return uniqueIds.map((id) => byId.get(id)).filter((session): session is SessionInfo => Boolean(session));
}

function postgresBigintArrayLiteral(values: string[]) {
  return `{${values.join(",")}}`;
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
  const cursor = parseSyncCursor(body.cursor);
  if (body.metadataOnly) {
    const metadata = await syncMetadata(body);
    const response: SyncResponse = {
      cursor: formatSyncCursor(cursor.legacy.toString(), cursor.v2.toString()),
      hasMore: metadata.hasMore,
      approxBytes: 0,
      metadataCursor: metadata.cursor,
      metadataHasMore: metadata.hasMore,
      metadataMode: metadata.mode,
      metadataFull: metadata.full,
      hosts: metadata.hosts,
      sessions: metadata.sessions,
      events: [],
    };
    response.approxBytes = byteSize(JSON.stringify(response));
    return response;
  }

  const fetchLimit = 10000;
  const [legacyRows, v2Rows] = await Promise.all([
    sql`
    select id, session_db_id, source_line_no, source_offset, event_type, role, occurred_at, ingested_at, raw
    from session_events
    where id > ${cursor.legacy}
    order by id asc
    limit ${fetchLimit}
  `,
    listV2EventsForSync(sql, cursor.v2, fetchLimit),
  ]);

  const events = [];
  let approxBytes = 2;
  let hasMore = legacyRows.length === fetchLimit || v2Rows.length === fetchLimit;
  let nextLegacyCursor = cursor.legacy.toString();
  let nextV2Cursor = cursor.v2.toString();

  for (const row of legacyRows) {
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
    nextLegacyCursor = toId(row.id);
    approxBytes += eventBytes;
  }

  for (const row of v2Rows) {
    const event = mapV2EventRow(row);
    const eventBytes = byteSize(JSON.stringify(event)) + 1;
    if (events.length && approxBytes + eventBytes > limitBytes) {
      hasMore = true;
      break;
    }
    events.push(event);
    nextV2Cursor = toId(row.id);
    approxBytes += eventBytes;
  }

  const nextCursor = formatSyncCursor(nextLegacyCursor, nextV2Cursor);
  const sessionIds = [...new Set(events.map((event) => event.sessionDbId))];
  const legacySessionIds = sessionIds.filter((id) => !isV2SessionId(id));
  const v2SessionIds = new Set(sessionIds.filter(isV2SessionId));
  const [legacySessions, v2Sessions] = await Promise.all([
    legacySessionIds.length ? getSessionsMeta(legacySessionIds) : [],
    v2SessionIds.size ? getV2SessionsMeta(sql, [...v2SessionIds].map((id) => parseV2SessionId(id)).filter((id): id is string => Boolean(id))) : [],
  ]);
  const sessions = [...legacySessions, ...v2Sessions];

  const hosts = await listReadableHosts();
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

type MetadataMode = "full" | "delta";
type MetadataChangeKey = {
  kind: "" | "h" | "l" | "v";
  id: string;
  at: string;
};

async function syncMetadata(body: SyncRequest): Promise<{
  mode: MetadataMode;
  full: boolean;
  hasMore: boolean;
  cursor: string;
  hosts: HostInfo[];
  sessions: SessionInfo[];
}> {
  const requestedMode = body.metadataMode === "delta" || body.metadataMode === "full" ? body.metadataMode : null;
  const mode: MetadataMode = requestedMode ?? (body.metadataCursor ? "delta" : "full");
  const parsedCursor = body.metadataCursor ? parseMetadataCursor(body.metadataCursor) : null;

  if (mode === "full" || !parsedCursor) return syncFullMetadata();

  const limit = clamp(Math.floor(body.metadataLimit ?? 500), 50, 2000);
  const rows = await listMetadataChangeKeys(parsedCursor, limit + 1);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const hostIds = new Set(page.filter((row) => row.kind === "h").map((row) => row.id));
  const legacySessionIds = page.filter((row) => row.kind === "l").map((row) => row.id);
  const v2SourceFileIds = page.filter((row) => row.kind === "v").map((row) => row.id);

  const [legacySessions, v2Sessions] = await Promise.all([
    legacySessionIds.length ? getSessionsMeta(legacySessionIds) : Promise.resolve([]),
    v2SourceFileIds.length ? getV2SessionsMeta(sql, v2SourceFileIds, { includeDeleted: true }) : Promise.resolve([]),
  ]);
  for (const session of [...legacySessions, ...v2Sessions]) hostIds.add(session.agentId);
  const hosts = hostIds.size ? (await listReadableHosts()).filter((host) => hostIds.has(host.agentId)) : [];
  const cursor = page.length ? formatMetadataCursor(page[page.length - 1]) : formatMetadataCursor(parsedCursor);
  return { mode, full: false, hasMore, cursor, hosts, sessions: [...legacySessions, ...v2Sessions] };
}

async function syncFullMetadata(): Promise<{
  mode: MetadataMode;
  full: boolean;
  hasMore: boolean;
  cursor: string;
  hosts: HostInfo[];
  sessions: SessionInfo[];
}> {
  const cursor = await currentMetadataCursor();
  const [hosts, sessions] = await Promise.all([listReadableHosts(), listReadableSessions()]);
  return { mode: "full", full: true, hasMore: false, cursor, hosts, sessions };
}

async function listMetadataChangeKeys(cursor: MetadataChangeKey, limit: number): Promise<MetadataChangeKey[]> {
  const rows = await sql`
    with changes as (
      select 'h'::text as kind, a.id::text as row_id, a.last_seen_at as changed_at
      from agents a
      where (a.last_seen_at, 'h'::text, a.id::text) > (${cursor.at}::timestamptz, ${cursor.kind}, ${cursor.id})
      union all
      select 'l'::text as kind, s.id::text as row_id, greatest(s.last_seen_at, coalesce(s.deleted_at, s.last_seen_at)) as changed_at
      from chat_sessions s
      where (
        greatest(s.last_seen_at, coalesce(s.deleted_at, s.last_seen_at)),
        'l'::text,
        s.id::text
      ) > (${cursor.at}::timestamptz, ${cursor.kind}, ${cursor.id})
      union all
      select 'v'::text as kind, f.id::text as row_id, greatest(f.last_seen_at, coalesce(f.deleted_at, f.last_seen_at)) as changed_at
      from agent_source_files f
      where f.source_kind = 'conversation'
        and (
          greatest(f.last_seen_at, coalesce(f.deleted_at, f.last_seen_at)),
          'v'::text,
          f.id::text
        ) > (${cursor.at}::timestamptz, ${cursor.kind}, ${cursor.id})
    )
    select kind, row_id, changed_at
    from changes
    order by changed_at asc, kind asc, row_id asc
    limit ${limit}
  `;
  return rows.map((row: any) => ({
    kind: row.kind,
    id: String(row.row_id),
    at: metadataTimestampString(row.changed_at),
  }));
}

async function currentMetadataCursor() {
  const rows = await sql`
    with changes as (
      select 'h'::text as kind, a.id::text as row_id, a.last_seen_at as changed_at
      from agents a
      union all
      select 'l'::text as kind, s.id::text as row_id, greatest(s.last_seen_at, coalesce(s.deleted_at, s.last_seen_at)) as changed_at
      from chat_sessions s
      union all
      select 'v'::text as kind, f.id::text as row_id, greatest(f.last_seen_at, coalesce(f.deleted_at, f.last_seen_at)) as changed_at
      from agent_source_files f
      where f.source_kind = 'conversation'
    )
    select kind, row_id, changed_at
    from changes
    order by changed_at desc, kind desc, row_id desc
    limit 1
  `;
  if (!rows.length) return formatMetadataCursor(initialMetadataCursor());
  return formatMetadataCursor({ kind: rows[0].kind, id: String(rows[0].row_id), at: metadataTimestampString(rows[0].changed_at) });
}

function initialMetadataCursor(): MetadataChangeKey {
  return { at: "1970-01-01T00:00:00.000Z", kind: "", id: "" };
}

function parseMetadataCursor(value: string | undefined): MetadataChangeKey | null {
  if (!value?.startsWith("meta:")) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice("meta:".length), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const at = normalizeMetadataCursorTimestamp(parsed.at);
    const kind: MetadataChangeKey["kind"] | null =
      parsed.kind === "h" || parsed.kind === "l" || parsed.kind === "v" ? parsed.kind : null;
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (!at || !kind || !id) return null;
    return { at, kind, id };
  } catch {
    return null;
  }
}

function normalizeMetadataCursorTimestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function metadataTimestampString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function formatMetadataCursor(cursor: MetadataChangeKey) {
  return `meta:${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
}

function parseSyncCursor(value: string | undefined): { legacy: bigint; v2: bigint } {
  if (!value) return { legacy: 0n, v2: 0n };
  const compound = /^sync:(\d+):(\d+)$/.exec(value);
  if (compound) return { legacy: BigInt(compound[1]), v2: BigInt(compound[2]) };
  if (/^\d+$/.test(value)) return { legacy: BigInt(value), v2: 0n };
  return { legacy: 0n, v2: 0n };
}

function formatSyncCursor(legacy: unknown, v2: unknown) {
  return `sync:${toId(legacy ?? "0")}:${toId(v2 ?? "0")}`;
}

function mapSession(row: any): SessionInfo {
  return {
    id: toId(row.id),
    agentId: row.agent_id,
    hostname: row.hostname,
    sourceProvider: "claude",
    sourceKind: "conversation",
    sourceGeneration: null,
    sourceId: toId(row.id),
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
  const legacySessionDbId = numericSessionDbId(sessionDbId);
  await sql`
    insert into yjs_documents (doc_id, session_db_id, update, updated_at)
    values (${docId}, ${legacySessionDbId}, ${Buffer.from(merged)}, now())
    on conflict (doc_id) do update set
      session_db_id = coalesce(excluded.session_db_id, yjs_documents.session_db_id),
      update = excluded.update,
      updated_at = now()
  `;
}

function numericSessionDbId(value?: string) {
  return value && /^\d+$/.test(value) ? value : null;
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

async function prepareDataDir() {
  if (!dataDir) return;
  await mkdir(blobPath("healthcheck"), { recursive: true });
}

async function storeBlob(namespace: string, sha256: string, bytes: Buffer) {
  if (!dataDir) return { storageKey: null as string | null, dbBytes: bytes };

  const storageKey = blobStorageKey(namespace, sha256);
  const path = dataPath(storageKey);
  await mkdir(join(dataDir, "blobs", namespace, sha256.slice(0, 2)), { recursive: true });
  await writeFile(path, bytes);
  return { storageKey, dbBytes: null as Buffer | null };
}

async function loadStoredBlob(row: { bytes?: unknown; storage_key?: string | null }) {
  if (row.storage_key) {
    try {
      return await readFile(dataPath(row.storage_key));
    } catch (error) {
      if (row.bytes == null) throw error;
    }
  }
  if (row.bytes == null) throw new Error("stored blob is missing bytes and storage_key");
  return Buffer.from(toBytes(row.bytes));
}

async function deleteStoredBlob(storageKey: string) {
  if (!dataDir) return;
  await unlink(dataPath(storageKey)).catch((error) => {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  });
}

async function backfillMediaBlobStorage() {
  if (!dataDir) return;
  const rows = await sql`
    select id, media_kind, sha256, bytes
    from import_media_blobs
    where storage_key is null
      and bytes is not null
    order by id
    limit 500
  `;
  let moved = 0;
  for (const row of rows) {
    const bytes = Buffer.from(toBytes(row.bytes));
    const storage = await storeBlob(`import-${row.media_kind || "media"}`, row.sha256, bytes);
    await sql`
      update import_media_blobs
      set storage_key = ${storage.storageKey},
          bytes = null
      where id = ${row.id}
        and storage_key is null
    `;
    moved++;
  }
  if (moved) console.log(`moved ${moved} media blob(s) to DATA_DIR`);
}

function blobStorageKey(namespace: string, sha256: string) {
  return `blobs/${safePathPart(namespace)}/${sha256.slice(0, 2)}/${sha256}`;
}

function blobPath(namespace: string) {
  return join(dataDir, "blobs", safePathPart(namespace));
}

function dataPath(storageKey: string) {
  if (!dataDir) throw new Error("DATA_DIR is not configured");
  const normalized = normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, "");
  if (normalized.startsWith("/") || normalized.includes("..")) throw new Error("invalid storage key");
  return join(dataDir, normalized);
}

function safePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-") || "blob";
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
