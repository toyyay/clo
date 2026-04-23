import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import type { AgentIdentity, IngestBatchRequest, IngestEvent, IngestSession } from "../../packages/shared/types";

const VERSION = "0.1.0";

type Config = {
  backendUrl: string;
  token: string;
  projectsDir: string;
  statePath: string;
  pollMs: number;
  readChunkBytes: number;
};

type FileState = {
  offset: number;
  lineNo: number;
  sizeBytes: number;
  mtimeMs: number;
};

type AgentState = {
  agentId: string;
  files: Record<string, FileState>;
};

type JsonlFile = {
  projectKey: string;
  projectName: string;
  sessionId: string;
  sourcePath: string;
  sizeBytes: number;
  mtimeMs: number;
};

const command = Bun.argv[2] ?? "run";

switch (command) {
  case "run":
    await run(false);
    break;
  case "scan-once":
    await run(true);
    break;
  case "install-launch-agent":
    await installLaunchAgent();
    break;
  case "print-launch-agent":
    console.log(launchAgentPlist(loadConfig()));
    break;
  default:
    printHelp();
    process.exit(command === "help" || command === "--help" ? 0 : 1);
}

async function run(once: boolean) {
  const config = loadConfig();
  if (!config.token) throw new Error("CHATVIEW_AGENT_TOKEN or --token is required");

  const state = await loadState(config.statePath);
  const identity = identityFor(config, state.agentId);
  state.agentId = identity.agentId;
  await saveState(config.statePath, state);

  console.log(`chatview agent ${VERSION} on ${identity.hostname}; watching ${config.projectsDir}`);
  console.log(`sending to ${config.backendUrl}`);

  do {
    try {
      await scanAndFlush(config, identity, state);
      await saveState(config.statePath, state);
    } catch (error) {
      console.error(`[agent] ${error instanceof Error ? error.message : String(error)}`);
    }
    if (once) break;
    await sleep(config.pollMs);
  } while (true);
}

function loadConfig(): Config {
  return {
    backendUrl: trimSlash(arg("--backend") ?? process.env.CHATVIEW_BACKEND_URL ?? "http://localhost:3737"),
    token: arg("--token") ?? process.env.CHATVIEW_AGENT_TOKEN ?? "",
    projectsDir: arg("--projects-dir") ?? process.env.CHATVIEW_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects"),
    statePath: arg("--state") ?? process.env.CHATVIEW_AGENT_STATE ?? join(homedir(), ".chatview-agent", "state.json"),
    pollMs: Number(arg("--poll-ms") ?? process.env.CHATVIEW_POLL_MS ?? 2000),
    readChunkBytes: Number(arg("--read-chunk-bytes") ?? process.env.CHATVIEW_READ_CHUNK_BYTES ?? 1024 * 1024),
  };
}

async function scanAndFlush(config: Config, identity: AgentIdentity, state: AgentState) {
  const files = await listJsonlFiles(config.projectsDir);
  let sentEvents = 0;

  for (const file of files) {
    const current = state.files[file.sourcePath] ?? { offset: 0, lineNo: 0, sizeBytes: 0, mtimeMs: 0 };
    const update = await readAppend(file, current, config.readChunkBytes);
    if (!update || !update.session.events.length) {
      state.files[file.sourcePath] = update?.nextState ?? current;
      continue;
    }

    const body: IngestBatchRequest = {
      agent: identity,
      sessions: [update.session],
    };

    const response = await fetch(`${config.backendUrl}/api/ingest/batch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`ingest failed for ${file.sourcePath}: ${response.status} ${await response.text()}`);
    }

    state.files[file.sourcePath] = update.nextState;
    sentEvents += update.session.events.length;
  }

  if (sentEvents) console.log(`[agent] sent ${sentEvents} event(s)`);
}

async function listJsonlFiles(projectsDir: string): Promise<JsonlFile[]> {
  const out: JsonlFile[] = [];
  let projects: string[];

  try {
    projects = await readdir(projectsDir);
  } catch (error) {
    throw new Error(`cannot read projects dir ${projectsDir}: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const projectKey of projects) {
    const projectPath = join(projectsDir, projectKey);
    let projectStat;
    try {
      projectStat = await stat(projectPath);
    } catch {
      continue;
    }
    if (!projectStat.isDirectory()) continue;

    let names: string[];
    try {
      names = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const sourcePath = join(projectPath, name);
      const fileStat = await stat(sourcePath);
      if (!fileStat.isFile()) continue;
      out.push({
        projectKey,
        projectName: shortProject(projectKey),
        sessionId: name.replace(/\.jsonl$/, ""),
        sourcePath,
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      });
    }
  }

  out.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return out;
}

async function readAppend(file: JsonlFile, current: FileState, readChunkBytes: number) {
  let offset = current.offset;
  let lineNo = current.lineNo;

  if (file.sizeBytes < offset) {
    offset = 0;
    lineNo = 0;
  }

  if (file.sizeBytes === offset) {
    return {
      session: emptySession(file),
      nextState: { offset, lineNo, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs },
    };
  }

  const end = Math.min(file.sizeBytes, offset + readChunkBytes);
  const chunk = await Bun.file(file.sourcePath).slice(offset, end).text();
  if (!chunk) return null;

  const newline = chunk.lastIndexOf("\n");
  if (newline < 0) return null;

  const complete = chunk.slice(0, newline + 1);
  const events: IngestEvent[] = [];
  let cursorOffset = offset;

  for (const rawLine of complete.split("\n").slice(0, -1)) {
    const lineOffset = cursorOffset;
    cursorOffset += Buffer.byteLength(`${rawLine}\n`, "utf8");
    lineNo += 1;
    if (!rawLine.trim()) continue;

    const raw = parseLine(rawLine);
    const meta = eventMeta(raw);
    events.push({
      lineNo,
      offset: lineOffset,
      raw,
      eventType: meta.eventType,
      role: meta.role,
      createdAt: meta.createdAt,
      title: meta.title,
    });
  }

  return {
    session: {
      ...emptySession(file),
      events,
    },
    nextState: {
      offset: offset + Buffer.byteLength(complete, "utf8"),
      lineNo,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
    },
  };
}

function emptySession(file: JsonlFile): IngestSession {
  return {
    projectKey: file.projectKey,
    projectName: file.projectName,
    sessionId: file.sessionId,
    sourcePath: file.sourcePath,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    events: [],
  };
}

function parseLine(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "malformed", line };
  }
}

function eventMeta(raw: any) {
  const eventType = typeof raw?.type === "string" ? raw.type : undefined;
  const role = typeof raw?.message?.role === "string" ? raw.message.role : undefined;
  const createdAt = validDate(raw?.timestamp ?? raw?.created_at ?? raw?.createdAt);
  const title = raw?.type === "ai-title" && typeof raw?.aiTitle === "string" ? raw.aiTitle : undefined;
  return { eventType, role, createdAt, title };
}

function validDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

async function loadState(path: string): Promise<AgentState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : randomUUID(),
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
    };
  } catch {
    return { agentId: randomUUID(), files: {} };
  }
}

async function saveState(path: string, state: AgentState) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function identityFor(config: Config, agentId: string): AgentIdentity {
  return {
    agentId,
    hostname: process.env.CHATVIEW_AGENT_HOSTNAME ?? hostname(),
    platform: platform(),
    arch: arch(),
    version: VERSION,
    sourceRoot: config.projectsDir,
  };
}

async function installLaunchAgent() {
  const config = loadConfig();
  if (!config.token) throw new Error("CHATVIEW_AGENT_TOKEN or --token is required before installing launch agent");
  const label = "com.chatview.agent";
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, launchAgentPlist(config));
  console.log(`wrote ${plistPath}`);
  console.log(`load with: launchctl bootstrap gui/$(id -u) ${plistPath}`);
  console.log(`stop with: launchctl bootout gui/$(id -u) ${plistPath}`);
}

function launchAgentPlist(config: Config) {
  const args = launchProgramArguments();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chatview.agent</string>
  <key>ProgramArguments</key>
  <array>
${args.map((value) => `    <string>${xml(value)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHATVIEW_BACKEND_URL</key>
    <string>${xml(config.backendUrl)}</string>
    <key>CHATVIEW_AGENT_TOKEN</key>
    <string>${xml(config.token)}</string>
    <key>CHATVIEW_CLAUDE_PROJECTS_DIR</key>
    <string>${xml(config.projectsDir)}</string>
    <key>CHATVIEW_AGENT_STATE</key>
    <string>${xml(config.statePath)}</string>
    <key>CHATVIEW_POLL_MS</key>
    <string>${xml(String(config.pollMs))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(homedir(), "Library", "Logs", "chatview-agent.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(homedir(), "Library", "Logs", "chatview-agent.err.log"))}</string>
</dict>
</plist>
`;
}

function launchProgramArguments() {
  if (Bun.argv[1]?.endsWith(".ts")) return [Bun.argv[0], Bun.argv[1], "run"];
  return [process.execPath, "run"];
}

function printHelp() {
  console.log(`chatview-agent ${VERSION}

Usage:
  chatview-agent run
  chatview-agent scan-once
  chatview-agent install-launch-agent

Options:
  --backend <url>          Backend URL (default: http://localhost:3737)
  --token <token>          Agent token, or CHATVIEW_AGENT_TOKEN
  --projects-dir <path>    Claude projects dir (default: ~/.claude/projects)
  --state <path>           Agent state file (default: ~/.chatview-agent/state.json)
  --poll-ms <ms>           Poll interval (default: 2000)
`);
}

function arg(name: string) {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function shortProject(raw: string) {
  return raw.replace(/^-Users-[^-]+-/, "").replace(/^p-?/, (match) => (match === "p" ? "p" : "")) || raw;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
