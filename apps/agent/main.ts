import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { arch, homedir, hostname, platform } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { Buffer } from "node:buffer";
import type {
  AgentIdentity,
  FileMetadata,
  GitMetadata,
  IngestBatchRequest,
  IngestEvent,
  IngestSession,
} from "../../packages/shared/types";
import { envValue } from "../../packages/shared/env";

declare const CHATVIEW_EMBEDDED_BACKEND_URL: string | undefined;
declare const CHATVIEW_EMBEDDED_AGENT_TOKEN: string | undefined;
declare const CHATVIEW_DEFAULT_COMMAND: string | undefined;

const VERSION = "0.1.0";
const LABEL = "com.chatview.agent";
const APP_DIR = join(homedir(), "Library", "Application Support", "ChatviewAgent");
const INSTALLED_EXECUTABLE_PATH = join(APP_DIR, "chatview-agent");
const DEFAULT_BACKEND_URL =
  typeof CHATVIEW_EMBEDDED_BACKEND_URL !== "undefined" ? CHATVIEW_EMBEDDED_BACKEND_URL : "https://clo.vf.lc";
const DEFAULT_AGENT_TOKEN = typeof CHATVIEW_EMBEDDED_AGENT_TOKEN !== "undefined" ? CHATVIEW_EMBEDDED_AGENT_TOKEN : "";
const DEFAULT_COMMAND = typeof CHATVIEW_DEFAULT_COMMAND !== "undefined" ? CHATVIEW_DEFAULT_COMMAND : "run";

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
  projectKey?: string;
  projectName?: string;
  sessionId?: string;
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

const command = Bun.argv[2] ?? DEFAULT_COMMAND;

switch (command) {
  case "run":
    await run(false);
    break;
  case "scan-once":
    await run(true);
    break;
  case "install":
  case "install-self":
    await installSelf();
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
  if (!config.token) throw new Error("AGENT_TOKEN or --token is required");

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
  const pollMs = arg("--poll-ms") ?? envValue(process.env, "POLL_MS", "CHATVIEW_POLL_MS");
  const readChunkBytes = arg("--read-chunk-bytes") ?? envValue(process.env, "READ_CHUNK_BYTES", "CHATVIEW_READ_CHUNK_BYTES");

  return {
    backendUrl: trimSlash(arg("--backend") ?? envValue(process.env, "BACKEND_URL", "CHATVIEW_BACKEND_URL") ?? DEFAULT_BACKEND_URL),
    token: arg("--token") ?? envValue(process.env, "AGENT_TOKEN", "CHATVIEW_AGENT_TOKEN") ?? DEFAULT_AGENT_TOKEN,
    projectsDir:
      arg("--projects-dir") ??
      envValue(process.env, "CLAUDE_PROJECTS_DIR", "CHATVIEW_CLAUDE_PROJECTS_DIR") ??
      join(homedir(), ".claude", "projects"),
    statePath: arg("--state") ?? envValue(process.env, "AGENT_STATE", "CHATVIEW_AGENT_STATE") ?? join(homedir(), ".chatview-agent", "state.json"),
    pollMs: positiveInteger(pollMs, 2000),
    readChunkBytes: positiveInteger(readChunkBytes, 1024 * 1024),
  };
}

async function scanAndFlush(config: Config, identity: AgentIdentity, state: AgentState) {
  const files = await listJsonlFiles(config.projectsDir);
  const currentPaths = new Set(files.map((f) => f.sourcePath));
  const gitCache = new Map<string, GitMetadata | undefined>();
  let sentEvents = 0;

  for (const file of files) {
    const current = state.files[file.sourcePath] ?? { offset: 0, lineNo: 0, sizeBytes: 0, mtimeMs: 0 };
    const identityFields = { projectKey: file.projectKey, projectName: file.projectName, sessionId: file.sessionId };
    const update = await readAppend(file, current, config.readChunkBytes);
    if (!update || !update.session.events.length) {
      state.files[file.sourcePath] = { ...(update?.nextState ?? current), ...identityFields };
      continue;
    }

    const fileMeta = await collectFileMetadata(file.sourcePath, update.contentSha256);
    const gitMeta = await collectGitMetadata(file.sourcePath, gitCache);

    const session: IngestSession = {
      ...update.session,
      file: fileMeta,
      git: gitMeta,
    };

    const body: IngestBatchRequest = {
      agent: identity,
      sessions: [session],
    };

    await postIngest(config, body, file.sourcePath);

    state.files[file.sourcePath] = { ...update.nextState, ...identityFields };
    sentEvents += update.session.events.length;
  }

  for (const path of Object.keys(state.files)) {
    if (currentPaths.has(path)) continue;
    const prior = state.files[path];
    if (!prior?.projectKey || !prior?.sessionId) {
      delete state.files[path];
      continue;
    }
    const deletedSession: IngestSession = {
      projectKey: prior.projectKey,
      projectName: prior.projectName,
      sessionId: prior.sessionId,
      sourcePath: path,
      sizeBytes: prior.sizeBytes ?? 0,
      mtimeMs: prior.mtimeMs ?? 0,
      events: [],
      deleted: true,
    };
    try {
      await postIngest(config, { agent: identity, sessions: [deletedSession] }, path);
      delete state.files[path];
    } catch (error) {
      console.error(`[agent] failed to mark deleted ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (sentEvents) console.log(`[agent] sent ${sentEvents} event(s)`);
}

async function postIngest(config: Config, body: IngestBatchRequest, sourcePath: string) {
  const response = await fetchWithRetry(`${config.backendUrl}/api/ingest/batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`ingest failed for ${sourcePath}: ${response.status} ${await response.text()}`);
  }
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const maxAttempts = 8;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        await response.body?.cancel().catch(() => {});
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt === maxAttempts - 1) break;
    const base = Math.min(8000, 500 * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
      contentSha256: undefined as string | undefined,
    };
  }

  const end = Math.min(file.sizeBytes, offset + readChunkBytes);
  const buf = Buffer.from(await Bun.file(file.sourcePath).slice(offset, end).arrayBuffer());
  if (buf.length === 0) return null;

  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) return null;

  const completeBytes = buf.subarray(0, lastNewline + 1);
  const decoder = new TextDecoder("utf-8");
  const events: IngestEvent[] = [];
  let cursor = 0;

  while (cursor <= lastNewline) {
    const nlIdx = completeBytes.indexOf(0x0a, cursor);
    if (nlIdx < 0) break;
    const lineBytes = completeBytes.subarray(cursor, nlIdx);
    const lineOffset = offset + cursor;
    cursor = nlIdx + 1;
    lineNo += 1;
    const rawLine = decoder.decode(lineBytes);
    if (!rawLine.trim()) continue;

    const raw = sanitizeJson(parseLine(rawLine));
    const meta = eventMeta(raw);
    events.push({
      lineNo,
      offset: lineOffset,
      raw,
      eventType: meta.eventType,
      role: meta.role,
      createdAt: meta.createdAt,
      title: meta.title,
      lineSha256: sha256Hex(lineBytes),
    });
  }

  const nextOffset = offset + completeBytes.length;
  const contentSha256 = await hashFileRange(file.sourcePath, nextOffset);

  return {
    session: {
      ...emptySession(file),
      events,
    },
    nextState: {
      offset: nextOffset,
      lineNo,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
    },
    contentSha256,
  };
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function hashFileRange(path: string, endByte: number): Promise<string | undefined> {
  try {
    const buf = Buffer.from(await Bun.file(path).slice(0, endByte).arrayBuffer());
    return sha256Hex(buf);
  } catch {
    return undefined;
  }
}

async function collectFileMetadata(path: string, contentSha256: string | undefined): Promise<FileMetadata> {
  const meta: FileMetadata = { mimeType: "application/x-ndjson" };
  if (contentSha256) meta.contentSha256 = contentSha256;
  try {
    const ls = await lstat(path);
    meta.mode = ls.mode;
    if (ls.isSymbolicLink()) {
      try {
        meta.symlinkTarget = await readlink(path);
      } catch {}
    }
  } catch {}
  return meta;
}

async function collectGitMetadata(
  sourcePath: string,
  cache: Map<string, GitMetadata | undefined>,
): Promise<GitMetadata | undefined> {
  try {
    const repoRoot = await findGitRepoRoot(sourcePath);
    if (!repoRoot) return undefined;
    if (cache.has(repoRoot)) return cache.get(repoRoot);
    const meta: GitMetadata = { repoRoot };
    meta.commit = runGit(repoRoot, ["rev-parse", "HEAD"]);
    meta.branch = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const porcelain = runGitRaw(repoRoot, ["status", "--porcelain"]);
    if (porcelain !== undefined) meta.dirty = porcelain.length > 0;
    meta.remoteUrl = runGit(repoRoot, ["config", "--get", "remote.origin.url"]);
    cache.set(repoRoot, meta);
    return meta;
  } catch {
    return undefined;
  }
}

async function findGitRepoRoot(startPath: string): Promise<string | undefined> {
  let dir = dirname(startPath);
  const root = parsePath(dir).root;
  while (true) {
    try {
      const s = await stat(join(dir, ".git"));
      if (s.isDirectory() || s.isFile()) return dir;
    } catch {}
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function runGit(repoRoot: string, args: string[]): string | undefined {
  const out = runGitRaw(repoRoot, args);
  return out && out.length ? out : undefined;
}

function runGitRaw(repoRoot: string, args: string[]): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", "-C", repoRoot, ...args], { stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return undefined;
    return new TextDecoder().decode(proc.stdout).trim();
  } catch {
    return undefined;
  }
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

function sanitizeJson(value: unknown): any {
  if (typeof value === "string") return value.replaceAll("\u0000", "");
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k.replaceAll("\u0000", "")] = sanitizeJson(v);
    return out;
  }
  return value;
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
    hostname: envValue(process.env, "AGENT_HOSTNAME", "CHATVIEW_AGENT_HOSTNAME") ?? hostname(),
    platform: platform(),
    arch: arch(),
    version: VERSION,
    sourceRoot: config.projectsDir,
  };
}

async function installLaunchAgent() {
  const config = loadConfig();
  if (!config.token) throw new Error("AGENT_TOKEN or --token is required before installing launch agent");
  const plistPath = await writeLaunchAgentPlist(config);
  console.log(`wrote ${plistPath}`);
  console.log(`load with: launchctl bootstrap gui/$(id -u) ${plistPath}`);
  console.log(`stop with: launchctl bootout gui/$(id -u) ${plistPath}`);
}

async function installSelf() {
  if (platform() !== "darwin") {
    throw new Error("install-self is only supported on macOS");
  }

  const config = loadConfig();
  if (!config.token) throw new Error("AGENT_TOKEN or --token is required before installing the standalone agent");

  await mkdir(dirname(INSTALLED_EXECUTABLE_PATH), { recursive: true });

  if (process.execPath !== INSTALLED_EXECUTABLE_PATH) {
    await copyFile(process.execPath, INSTALLED_EXECUTABLE_PATH);
    await chmod(INSTALLED_EXECUTABLE_PATH, 0o755);
  }

  const plistPath = await writeLaunchAgentPlist(config, [INSTALLED_EXECUTABLE_PATH, "run"]);
  bootstrapLaunchAgent(plistPath);

  console.log(`installed ${INSTALLED_EXECUTABLE_PATH}`);
  console.log("running first sync...");
  await run(true);
  console.log(`launch agent active: ${LABEL}`);
}

async function writeLaunchAgentPlist(config: Config, args = launchProgramArguments()) {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, launchAgentPlist(config, args));
  return plistPath;
}

function launchAgentPlist(config: Config, args = launchProgramArguments()) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((value) => `    <string>${xml(value)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BACKEND_URL</key>
    <string>${xml(config.backendUrl)}</string>
    <key>AGENT_TOKEN</key>
    <string>${xml(config.token)}</string>
    <key>CLAUDE_PROJECTS_DIR</key>
    <string>${xml(config.projectsDir)}</string>
    <key>AGENT_STATE</key>
    <string>${xml(config.statePath)}</string>
    <key>POLL_MS</key>
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

function bootstrapLaunchAgent(plistPath: string) {
  const uid = process.getuid?.();
  if (typeof uid !== "number") {
    throw new Error("cannot determine the current macOS user id for launchctl");
  }

  const domain = `gui/${uid}`;
  Bun.spawnSync(["launchctl", "bootout", domain, LABEL], { stderr: "ignore", stdout: "ignore" });

  const bootstrap = Bun.spawnSync(["launchctl", "bootstrap", domain, plistPath], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if (bootstrap.exitCode !== 0) {
    throw new Error(`launchctl bootstrap failed with exit code ${bootstrap.exitCode}`);
  }

  Bun.spawnSync(["launchctl", "kickstart", "-k", `${domain}/${LABEL}`], {
    stderr: "ignore",
    stdout: "ignore",
  });
}

function launchProgramArguments() {
  if (Bun.argv[1] && /\.(?:[cm]?js|tsx?|jsx)$/.test(Bun.argv[1])) return [process.execPath, Bun.argv[1], "run"];
  return [process.execPath, "run"];
}

function printHelp() {
  console.log(`chatview-agent ${VERSION}

Usage:
  chatview-agent run
  chatview-agent scan-once
  chatview-agent install-self
  chatview-agent install-launch-agent

Options:
  --backend <url>          Backend URL (default: ${DEFAULT_BACKEND_URL})
  --token <token>          Agent token, or AGENT_TOKEN
  --projects-dir <path>    Claude projects dir (default: ~/.claude/projects)
  --state <path>           Agent state file (default: ~/.chatview-agent/state.json)
  --poll-ms <ms>           Poll interval (default: 2000)

When a standalone downloadable executable is launched without arguments, it installs itself into:
  ${INSTALLED_EXECUTABLE_PATH}
`);
}

function arg(name: string) {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
