import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { arch, hostname, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { AGENT_V2_VERSION, type AgentV2Identity, type AgentV2State } from "./types";

const AGENT_V2_RUNTIME_ID = randomUUID();
const AGENT_V2_STARTED_AT = new Date().toISOString();

export function emptyAgentV2State(): AgentV2State {
  return { agentId: randomUUID(), cursors: {} };
}

export async function loadAgentV2State(path: string): Promise<AgentV2State> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyAgentV2State();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return backupCorruptState(path, raw);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return backupCorruptState(path, raw);
  }

  const record = parsed as Record<string, unknown>;
  return {
    agentId: typeof record.agentId === "string" ? record.agentId : randomUUID(),
    cursors: normalizeCursors(record.cursors),
    previewCursors: normalizeCursors(record.previewCursors),
  };
}

async function backupCorruptState(path: string, raw: string): Promise<AgentV2State> {
  const backupPath = corruptBackupPath(path);
  try {
    await rename(path, backupPath);
  } catch (backupError) {
    throw new Error(`failed to backup corrupt agent v2 state at ${path}: ${messageFor(backupError)}`, { cause: backupError });
  }

  return {
    agentId: recoverAgentId(raw) ?? randomUUID(),
    cursors: {},
  };
}

export function runtimeMetadataForAgentV2() {
  return {
    runtimeId: process.env.AGENT_RUNTIME_ID ?? process.env.CHATVIEW_AGENT_RUNTIME_ID ?? AGENT_V2_RUNTIME_ID,
    pid: process.pid,
    startedAt: parseableTimestamp(process.env.AGENT_STARTED_AT ?? process.env.CHATVIEW_AGENT_STARTED_AT) ?? AGENT_V2_STARTED_AT,
  };
}

function corruptBackupPath(path: string) {
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path}.corrupt-${safeTimestamp}-${randomUUID()}.bak`;
}

function recoverAgentId(raw: string): string | undefined {
  const match = raw.match(/"agentId"\s*:\s*("(?:(?:\\.)|[^"\\])*")/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseableTimestamp(value: string | undefined) {
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function saveAgentV2State(path: string, state: AgentV2State) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "w", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export function identityForAgentV2(state: AgentV2State): AgentV2Identity {
  return {
    agentId: state.agentId,
    hostname: process.env.AGENT_HOSTNAME ?? process.env.CHATVIEW_AGENT_HOSTNAME ?? hostname(),
    platform: platform(),
    arch: arch(),
    version: AGENT_V2_VERSION,
    ...runtimeMetadataForAgentV2(),
  };
}

function normalizeCursors(value: unknown): AgentV2State["cursors"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AgentV2State["cursors"] = {};
  for (const [path, cursor] of Object.entries(value as Record<string, unknown>)) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) continue;
    const record = cursor as Record<string, unknown>;
    out[path] = {
      generation: numberOr(record.generation, 1),
      offset: numberOr(record.offset, 0),
      lineNo: numberOr(record.lineNo, 0),
      sizeBytes: numberOr(record.sizeBytes, 0),
      mtimeMs: numberOr(record.mtimeMs, 0),
      tailSha256: typeof record.tailSha256 === "string" ? record.tailSha256 : undefined,
      dev: typeof record.dev === "number" ? record.dev : undefined,
      ino: typeof record.ino === "number" ? record.ino : undefined,
    };
  }
  return out;
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
