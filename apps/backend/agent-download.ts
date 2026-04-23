import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envValue } from "../../packages/shared/env";

const DEFAULT_PUBLIC_URL = "https://clo.vf.lc";
const EXECUTABLE_NAME = "chatview-agent.command";
const AGENT_ENTRYPOINT = new URL("../agent/main.ts", import.meta.url).pathname;
const ZIP_FLAGS_UTF8 = 0x0800;
const ZIP_VERSION = 20;

type CompileTarget = "bun-darwin-arm64" | "bun-darwin-x64";

type DownloadArtifact = {
  archive: Uint8Array;
  filename: string;
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
  const outfile = join(tempDir, EXECUTABLE_NAME);

  try {
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
      throw new Error(`failed to build downloadable agent${logs ? `:\n${logs}` : ""}`);
    }

    const binary = await readFile(outfile);

    return {
      archive: createZipArchive({
        name: EXECUTABLE_NAME,
        mode: 0o755,
        data: binary,
        mtime: new Date(),
      }),
      filename: `chatview-agent-macos-${target.endsWith("x64") ? "intel" : "arm64"}.zip`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function resolveCompileTarget(req: Request): CompileTarget {
  const url = new URL(req.url);
  const requestedArch = normalizeArch(url.searchParams.get("arch"));
  if (requestedArch === "x64") return "bun-darwin-x64";
  if (requestedArch === "arm64") return "bun-darwin-arm64";

  const userAgent = req.headers.get("user-agent") ?? "";
  if (/Macintosh/i.test(userAgent) && /Intel Mac OS X/i.test(userAgent)) return "bun-darwin-x64";
  return "bun-darwin-arm64";
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

function createZipArchive({
  name,
  mode,
  data,
  mtime,
}: {
  name: string;
  mode: number;
  data: Uint8Array;
  mtime: Date;
}) {
  const fileName = Buffer.from(name, "utf8");
  const content = Buffer.from(data);
  const crc = crc32(content);
  const dos = toDosDateTime(mtime);
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
  centralHeader.writeUInt32LE(((0o100000 | (mode & 0o7777)) * 0x10000) >>> 0, offset);
  offset += 4;
  centralHeader.writeUInt32LE(0, offset);
  offset += 4;
  fileName.copy(centralHeader, offset);

  const end = Buffer.alloc(22);
  offset = 0;
  end.writeUInt32LE(0x06054b50, offset);
  offset += 4;
  end.writeUInt16LE(0, offset);
  offset += 2;
  end.writeUInt16LE(0, offset);
  offset += 2;
  end.writeUInt16LE(1, offset);
  offset += 2;
  end.writeUInt16LE(1, offset);
  offset += 2;
  end.writeUInt32LE(centralHeader.length, offset);
  offset += 4;
  end.writeUInt32LE(localHeader.length + content.length, offset);
  offset += 4;
  end.writeUInt16LE(0, offset);

  return Buffer.concat([localHeader, content, centralHeader, end]);
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
