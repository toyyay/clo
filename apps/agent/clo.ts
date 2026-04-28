import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

declare const CLO_EMBEDDED_BASE_URL: string | undefined;
declare const CLO_EMBEDDED_UPDATE_TOKEN: string | undefined;

type CloManifest = {
  name: string;
  version: string;
  bundleUrl: string;
  sha256: string;
  sizeBytes: number;
  pollMs?: number;
  minRunnerVersion?: string;
};

const BASE_URL = trimSlash(typeof CLO_EMBEDDED_BASE_URL !== "undefined" ? CLO_EMBEDDED_BASE_URL : "https://clo.vf.lc");
const UPDATE_TOKEN = typeof CLO_EMBEDDED_UPDATE_TOKEN !== "undefined" ? CLO_EMBEDDED_UPDATE_TOKEN : "clo-home-update-v1";
const CLO_DIR = join(homedir(), ".clo");
const RELEASES_DIR = join(CLO_DIR, "releases");
const TMP_DIR = join(CLO_DIR, "tmp");
const CURRENT_LINK = join(CLO_DIR, "current");
const LOCK_PATH = join(CLO_DIR, "runner.lock");
const AGENT_FILE = "clo-agent.js";
const RUNNER_VERSION = "1";
const MIN_RESTART_MS = 10_000;
const DEFAULT_POLL_MS = 60_000;

let child: ReturnType<typeof Bun.spawn> | null = null;
let childStartedAt = 0;
let stopping = false;
let activeVersion = "";
let previousVersion = "";
const badVersions = new Set<string>();
let lockHandle: Awaited<ReturnType<typeof open>> | null = null;

const command = Bun.argv[2] ?? "run";

if (command === "version") {
  console.log(`clo ${RUNNER_VERSION} ${BASE_URL}`);
} else if (command === "update-once") {
  await updateOnce();
} else if (command === "run") {
  await run();
} else {
  console.log(`Usage:
  clo run
  clo update-once
  clo version`);
}

async function run() {
  await prepareDirs();
  await acquireLock();
  await migrateOldState();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  while (!stopping) {
    try {
      const manifest = await fetchManifest();
      assertRunnerCompatible(manifest);
      if (badVersions.has(manifest.version)) {
        await sleep(withJitter(manifest.pollMs ?? DEFAULT_POLL_MS));
        continue;
      }

      await ensureRelease(manifest);
      if (activeVersion !== manifest.version) {
        previousVersion = activeVersion;
        await switchToVersion(manifest.version);
      } else if (!child) {
        await startChild();
      }

      const result = await raceChildOrTimer(withJitter(manifest.pollMs ?? DEFAULT_POLL_MS));
      if (result === "child-exit" && !stopping) await handleChildExit();
    } catch (error) {
      console.error(`[clo] ${error instanceof Error ? error.message : String(error)}`);
      if (!child && activeVersion) await startChild().catch((startError) => console.error(startError));
      await sleep(withJitter(10_000));
    }
  }
}

async function updateOnce() {
  await prepareDirs();
  try {
    await acquireLock();
    await migrateOldState();
    const manifest = await fetchManifest();
    assertRunnerCompatible(manifest);
    await ensureRelease(manifest);
    await switchCurrentLink(manifest.version);
    console.log(`[clo] installed ${manifest.version}`);
  } finally {
    await releaseLock();
  }
}

async function fetchManifest(): Promise<CloManifest> {
  const response = await fetch(`${BASE_URL}/clo/manifest`, {
    headers: { authorization: `Bearer ${UPDATE_TOKEN}` },
  });
  if (!response.ok) throw new Error(`manifest failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<CloManifest>;
}

function assertRunnerCompatible(manifest: CloManifest) {
  const minRunner = Number(manifest.minRunnerVersion ?? 1);
  const current = Number(RUNNER_VERSION);
  if (Number.isFinite(minRunner) && minRunner > current) {
    throw new Error(`runner ${RUNNER_VERSION} is too old for ${manifest.version}; need ${manifest.minRunnerVersion}`);
  }
}

async function ensureRelease(manifest: CloManifest) {
  const releaseDir = releasePath(manifest.version);
  const agentPath = join(releaseDir, AGENT_FILE);
  if (existsSync(agentPath)) {
    const existing = await readFile(agentPath);
    if (sha256(existing) === manifest.sha256) return;
    await rm(releaseDir, { recursive: true, force: true });
  }

  await mkdir(TMP_DIR, { recursive: true });
  const tmpPath = join(TMP_DIR, `${sanitizeVersion(manifest.version)}-${process.pid}.js.tmp`);
  const response = await fetch(manifest.bundleUrl, {
    headers: { authorization: `Bearer ${UPDATE_TOKEN}` },
  });
  if (!response.ok) throw new Error(`bundle failed: ${response.status} ${await response.text()}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== manifest.sha256) {
    throw new Error(`bundle sha mismatch for ${manifest.version}: got ${digest}, want ${manifest.sha256}`);
  }
  if (manifest.sizeBytes && bytes.byteLength !== manifest.sizeBytes) {
    throw new Error(`bundle size mismatch for ${manifest.version}: got ${bytes.byteLength}, want ${manifest.sizeBytes}`);
  }

  await mkdir(releaseDir, { recursive: true });
  await writeFile(tmpPath, bytes);
  await chmod(tmpPath, 0o700);
  await rename(tmpPath, agentPath);
  await writeFile(join(releaseDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function switchToVersion(version: string) {
  await stopChild();
  await switchCurrentLink(version);
  activeVersion = version;
  console.log(`[clo] running ${version}`);
  await startChild();
}

async function switchCurrentLink(version: string) {
  const tmpLink = join(CLO_DIR, `current.${process.pid}.tmp`);
  await rm(tmpLink, { force: true, recursive: true });
  await symlink(releasePath(version), tmpLink);
  await rename(tmpLink, CURRENT_LINK);
}

async function startChild() {
  const agentPath = join(CURRENT_LINK, AGENT_FILE);
  childStartedAt = Date.now();
  child = Bun.spawn([process.execPath, agentPath, "run"], {
    cwd: CLO_DIR,
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv(),
  });
}

async function stopChild() {
  const running = child;
  if (!running) return;
  child = null;
  running.kill("SIGTERM");
  const exited = await Promise.race([running.exited, sleep(5_000).then(() => "timeout" as const)]);
  if (exited === "timeout") running.kill("SIGKILL");
}

async function handleChildExit() {
  const ranFor = Date.now() - childStartedAt;
  child = null;
  if (ranFor < MIN_RESTART_MS && previousVersion && previousVersion !== activeVersion) {
    console.error(`[clo] ${activeVersion} exited after ${ranFor}ms; rolling back to ${previousVersion}`);
    badVersions.add(activeVersion);
    await switchToVersion(previousVersion);
    return;
  }
  await sleep(2_000);
  await startChild();
}

async function raceChildOrTimer(ms: number) {
  const running = child;
  if (!running) {
    await sleep(ms);
    return "timer" as const;
  }
  return Promise.race([
    sleep(ms).then(() => "timer" as const),
    running.exited.then(() => "child-exit" as const),
  ]);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopChild();
  await releaseLock();
  process.exit(0);
}

async function prepareDirs() {
  await mkdir(RELEASES_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });
}

async function acquireLock() {
  try {
    lockHandle = await open(LOCK_PATH, "wx");
    await lockHandle.writeFile(`${process.pid}\n`);
  } catch {
    const owner = await readFile(LOCK_PATH, "utf8").catch(() => "unknown");
    const pid = Number(owner.trim());
    if (Number.isInteger(pid) && !processIsAlive(pid)) {
      await rm(LOCK_PATH, { force: true });
      lockHandle = await open(LOCK_PATH, "wx");
      await lockHandle.writeFile(`${process.pid}\n`);
      return;
    }
    throw new Error(`another clo runner appears active (${LOCK_PATH}: ${owner.trim()})`);
  }
}

async function releaseLock() {
  await lockHandle?.close().catch(() => {});
  lockHandle = null;
  await rm(LOCK_PATH, { force: true });
}

async function migrateOldState() {
  const next = join(CLO_DIR, "v2-state.json");
  const old = join(homedir(), ".chatview-agent", "v2-state.json");
  if (!existsSync(next) && existsSync(old)) {
    await mkdir(dirname(next), { recursive: true });
    await copyFile(old, next);
  }
}

function childEnv() {
  return {
    ...process.env,
    BACKEND_URL: process.env.BACKEND_URL ?? BASE_URL,
    AGENT_HOSTNAME: process.env.AGENT_HOSTNAME ?? process.env.CLO_HOSTNAME ?? hostname(),
    AGENT_STATE: process.env.AGENT_STATE ?? join(CLO_DIR, "v2-state.json"),
    AGENT_TAKEOVER: process.env.AGENT_TAKEOVER ?? "true",
    LOG_IDLE_EVERY_SCANS: process.env.LOG_IDLE_EVERY_SCANS ?? "30",
  };
}

function releasePath(version: string) {
  return join(RELEASES_DIR, sanitizeVersion(version));
}

function sanitizeVersion(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(ms: number) {
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.max(1_000, Math.round(ms * jitter));
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
