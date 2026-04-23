import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envValue } from "../../packages/shared/env";

const DEFAULT_PUBLIC_URL = "https://clo.vf.lc";
const EXECUTABLE_NAME = "chatview-agent";
const SCRIPT_NAME = "chatview-agent.js";
const AGENT_ENTRYPOINT = new URL("../agent/main.ts", import.meta.url).pathname;
const ZIP_FLAGS_UTF8 = 0x0800;
const ZIP_VERSION = 20;

type CompileTarget = "bun-darwin-arm64" | "bun-darwin-x64";

type DownloadArtifact = {
  archive: Uint8Array;
  filename: string;
};

type ZipFile = {
  name: string;
  mode: number;
  data: Uint8Array;
  mtime: Date;
};

const artifactPromises = new Map<string, Promise<DownloadArtifact>>();
const crc32Table = buildCrc32Table();

export async function downloadAgentArchiveResponse(req: Request, agentToken: string, env = process.env) {
  const publicUrl = trimSlash(envValue(env, "PUBLIC_URL", "CHATVIEW_PUBLIC_URL", "BACKEND_URL", "CHATVIEW_BACKEND_URL") ?? DEFAULT_PUBLIC_URL);
  const target = resolveCompileTarget(req);
  const artifact = await loadArtifact({ target, publicUrl, agentToken, gitSha: process.env.GIT_SHA ?? "unknown" });

  return new Response(toArrayBuffer(artifact.archive), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${artifact.filename}"`,
      "cache-control": "private, no-store, max-age=0",
    },
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    artifactPromises.clear();
  });
}

async function loadArtifact({
  target,
  publicUrl,
  agentToken,
  gitSha,
}: {
  target: CompileTarget;
  publicUrl: string;
  agentToken: string;
  gitSha: string;
}) {
  const cacheKey = [gitSha, target, publicUrl, tokenHash(agentToken)].join(":");
  let promise = artifactPromises.get(cacheKey);

  if (!promise) {
    promise = buildArtifact({ target, publicUrl, agentToken }).catch((error) => {
      artifactPromises.delete(cacheKey);
      throw error;
    });
    artifactPromises.set(cacheKey, promise);
  }

  return promise;
}

async function buildArtifact({
  target,
  publicUrl,
  agentToken,
}: {
  target: CompileTarget;
  publicUrl: string;
  agentToken: string;
}) {
  const tempDir = await mkdtemp(join(tmpdir(), "chatview-agent-"));
  const now = new Date();

  try {
    const [binary, script] = await Promise.all([
      buildCompiledAgent({ target, publicUrl, agentToken, tempDir }),
      buildReadableAgentBundle({ publicUrl, agentToken }),
    ]);

    return {
      archive: createZipArchive([
        { name: EXECUTABLE_NAME, mode: 0o755, data: binary, mtime: now },
        { name: SCRIPT_NAME, mode: 0o755, data: script, mtime: now },
      ]),
      filename: `chatview-agent-macos-${target.endsWith("x64") ? "intel" : "arm64"}.zip`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function buildCompiledAgent({
  target,
  publicUrl,
  agentToken,
  tempDir,
}: {
  target: CompileTarget;
  publicUrl: string;
  agentToken: string;
  tempDir: string;
}) {
  const outfile = join(tempDir, EXECUTABLE_NAME);
  const result = await Bun.build({
    entrypoints: [AGENT_ENTRYPOINT],
    compile: {
      target,
      outfile,
    },
    minify: false,
    sourcemap: "none",
    define: {
      CHATVIEW_EMBEDDED_BACKEND_URL: JSON.stringify(publicUrl),
      CHATVIEW_EMBEDDED_AGENT_TOKEN: JSON.stringify(agentToken),
      CHATVIEW_DEFAULT_COMMAND: JSON.stringify("install-self"),
    },
  });

  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join("\n");
    throw new Error(`failed to build downloadable macOS agent${logs ? `:\n${logs}` : ""}`);
  }

  return readFile(outfile);
}

async function buildReadableAgentBundle({
  publicUrl,
  agentToken,
}: {
  publicUrl: string;
  agentToken: string;
}) {
  const result = await Bun.build({
    entrypoints: [AGENT_ENTRYPOINT],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });

  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join("\n");
    throw new Error(`failed to build readable Bun agent bundle${logs ? `:\n${logs}` : ""}`);
  }

  const output = result.outputs.find((item) => item.kind === "entry-point");
  if (!output) {
    throw new Error("readable Bun agent bundle did not produce an entry point");
  }

  const source = await output.text();
  return Buffer.from(renderReadableAgentBundle({ source, publicUrl, agentToken }), "utf8");
}

function renderReadableAgentBundle({
  source,
  publicUrl,
  agentToken,
}: {
  source: string;
  publicUrl: string;
  agentToken: string;
}) {
  const header = [
    "// Chatview agent bundle for Bun.",
    "// Run in the foreground with: bun chatview-agent.js",
    "// Optional install step: bun chatview-agent.js install-launch-agent",
    "// You can edit these defaults before the rest of the bundle executes.",
    `const CHATVIEW_EMBEDDED_BACKEND_URL = ${JSON.stringify(publicUrl)};`,
    `const CHATVIEW_EMBEDDED_AGENT_TOKEN = ${JSON.stringify(agentToken)};`,
    `const CHATVIEW_DEFAULT_COMMAND = ${JSON.stringify("run")};`,
    "",
  ].join("\n");

  return `#!/usr/bin/env bun\n${insertHeaderAfterImports(source, header)}`;
}

function insertHeaderAfterImports(source: string, header: string) {
  const lines = source.split("\n");
  let insertAt = 0;
  let sawImport = false;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      insertAt = index + 1;
      continue;
    }

    if (trimmed.startsWith("//")) {
      insertAt = index + 1;
      continue;
    }

    if (trimmed.startsWith("import ")) {
      sawImport = true;
      insertAt = index + 1;
      continue;
    }

    if (sawImport && trimmed.startsWith("from ")) {
      insertAt = index + 1;
      continue;
    }

    break;
  }

  lines.splice(insertAt, 0, header);
  return lines.join("\n");
}

function resolveCompileTarget(req: Request): CompileTarget {
  return normalizeArch(new URL(req.url).searchParams.get("arch")) === "x64" ? "bun-darwin-x64" : "bun-darwin-arm64";
}

function normalizeArch(value: string | null) {
  switch ((value ?? "").toLowerCase()) {
    case "amd64":
    case "intel":
    case "x64":
      return "x64";
    case "aarch64":
    case "apple":
    case "arm":
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

function createZipArchive(files: ZipFile[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const file of files) {
    const fileName = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.data);
    const crc = crc32(content);
    const dos = toDosDateTime(file.mtime);

    const localHeader = Buffer.alloc(30 + fileName.length);
    let offset = 0;
    localHeader.writeUInt32LE(0x04034b50, offset);
    offset += 4;
    localHeader.writeUInt16LE(ZIP_VERSION, offset);
    offset += 2;
    localHeader.writeUInt16LE(ZIP_FLAGS_UTF8, offset);
    offset += 2;
    localHeader.writeUInt16LE(0, offset);
    offset += 2;
    localHeader.writeUInt16LE(dos.time, offset);
    offset += 2;
    localHeader.writeUInt16LE(dos.date, offset);
    offset += 2;
    localHeader.writeUInt32LE(crc, offset);
    offset += 4;
    localHeader.writeUInt32LE(content.length, offset);
    offset += 4;
    localHeader.writeUInt32LE(content.length, offset);
    offset += 4;
    localHeader.writeUInt16LE(fileName.length, offset);
    offset += 2;
    localHeader.writeUInt16LE(0, offset);
    offset += 2;
    fileName.copy(localHeader, offset);

    localParts.push(localHeader, content);

    const centralHeader = Buffer.alloc(46 + fileName.length);
    offset = 0;
    centralHeader.writeUInt32LE(0x02014b50, offset);
    offset += 4;
    centralHeader.writeUInt16LE((3 << 8) | ZIP_VERSION, offset);
    offset += 2;
    centralHeader.writeUInt16LE(ZIP_VERSION, offset);
    offset += 2;
    centralHeader.writeUInt16LE(ZIP_FLAGS_UTF8, offset);
    offset += 2;
    centralHeader.writeUInt16LE(0, offset);
    offset += 2;
    centralHeader.writeUInt16LE(dos.time, offset);
    offset += 2;
    centralHeader.writeUInt16LE(dos.date, offset);
    offset += 2;
    centralHeader.writeUInt32LE(crc, offset);
    offset += 4;
    centralHeader.writeUInt32LE(content.length, offset);
    offset += 4;
    centralHeader.writeUInt32LE(content.length, offset);
    offset += 4;
    centralHeader.writeUInt16LE(fileName.length, offset);
    offset += 2;
    centralHeader.writeUInt16LE(0, offset);
    offset += 2;
    centralHeader.writeUInt16LE(0, offset);
    offset += 2;
    centralHeader.writeUInt16LE(0, offset);
    offset += 2;
    centralHeader.writeUInt16LE(0, offset);
    offset += 2;
    centralHeader.writeUInt32LE(((0o100000 | (file.mode & 0o7777)) * 0x10000) >>> 0, offset);
    offset += 4;
    centralHeader.writeUInt32LE(localOffset, offset);
    offset += 4;
    fileName.copy(centralHeader, offset);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + content.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  let offset = 0;
  end.writeUInt32LE(0x06054b50, offset);
  offset += 4;
  end.writeUInt16LE(0, offset);
  offset += 2;
  end.writeUInt16LE(0, offset);
  offset += 2;
  end.writeUInt16LE(files.length, offset);
  offset += 2;
  end.writeUInt16LE(files.length, offset);
  offset += 2;
  end.writeUInt32LE(centralSize, offset);
  offset += 4;
  end.writeUInt32LE(localOffset, offset);
  offset += 4;
  end.writeUInt16LE(0, offset);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function toDosDateTime(date: Date) {
  const safeYear = Math.max(date.getFullYear(), 1980);
  return {
    date: ((safeYear - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function crc32(buffer: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
