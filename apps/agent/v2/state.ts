import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, hostname, platform } from "node:os";
import { dirname } from "node:path";
import { AGENT_V2_VERSION, type AgentV2Identity, type AgentV2State } from "./types";

export function emptyAgentV2State(): AgentV2State {
  return { agentId: randomUUID(), cursors: {} };
}

export async function loadAgentV2State(path: string): Promise<AgentV2State> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : randomUUID(),
      cursors: normalizeCursors(parsed.cursors),
      previewCursors: normalizeCursors(parsed.previewCursors),
    };
  } catch {
    return emptyAgentV2State();
  }
}

export async function saveAgentV2State(path: string, state: AgentV2State) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function identityForAgentV2(state: AgentV2State): AgentV2Identity {
  return {
    agentId: state.agentId,
    hostname: process.env.AGENT_HOSTNAME ?? process.env.CHATVIEW_AGENT_HOSTNAME ?? hostname(),
    platform: platform(),
    arch: arch(),
    version: AGENT_V2_VERSION,
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
