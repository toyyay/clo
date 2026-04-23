import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { envValue } from "../../packages/shared/env";

const DEFAULT_PUBLIC_URL = "https://clo.vf.lc";
const ARCHIVE_NAME = "chatview-agent-macos.tar.gz";
const INSTALLER_NAME = "chatview-agent.command";
const README_NAME = "README.txt";

let agentBundlePromise: Promise<string> | null = null;

export async function downloadAgentArchiveResponse(agentToken: string, env = process.env) {
  const publicUrl = trimSlash(envValue(env, "PUBLIC_URL", "CHATVIEW_PUBLIC_URL", "BACKEND_URL", "CHATVIEW_BACKEND_URL") ?? DEFAULT_PUBLIC_URL);
  const agentBundle = await loadAgentBundle();
  const installer = renderInstallerScript({
    agentBundle,
    publicUrl,
    agentToken,
  });
  const readme = renderReadme(publicUrl);
  const archive = gzipSync(
    createTarArchive([
      { name: INSTALLER_NAME, mode: 0o755, content: installer },
      { name: README_NAME, mode: 0o644, content: readme },
    ]),
  );

  return new Response(archive, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${ARCHIVE_NAME}"`,
      "cache-control": "no-store",
    },
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    agentBundlePromise = null;
  });
}

async function loadAgentBundle() {
  if (!agentBundlePromise) {
    agentBundlePromise = buildAgentBundle().catch((error) => {
      agentBundlePromise = null;
      throw error;
    });
  }

  return agentBundlePromise;
}

async function buildAgentBundle() {
  const result = await Bun.build({
    entrypoints: [new URL("../agent/main.ts", import.meta.url).pathname],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });

  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join("\n");
    throw new Error(`failed to build downloadable agent bundle${logs ? `:\n${logs}` : ""}`);
  }

  const output = result.outputs.find((item) => item.kind === "entry-point");
  if (!output) {
    throw new Error("downloadable agent bundle did not produce an entry point");
  }

  return output.text();
}

function renderInstallerScript({
  agentBundle,
  publicUrl,
  agentToken,
}: {
  agentBundle: string;
  publicUrl: string;
  agentToken: string;
}) {
  const delimiter = `__CHATVIEW_AGENT_JS_${createHash("sha256").update(agentBundle).digest("hex").slice(0, 16)}__`;

  return `#!/bin/bash
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/ChatviewAgent"
SCRIPT_PATH="$APP_DIR/chatview-agent.js"
BUN_INSTALL_DIR="\${BUN_INSTALL:-$HOME/.bun}"
BUN_BIN="$BUN_INSTALL_DIR/bin/bun"
BACKEND_URL="\${BACKEND_URL:-${escapeDoubleQuotedShell(publicUrl)}}"
AGENT_TOKEN="\${AGENT_TOKEN:-${escapeDoubleQuotedShell(agentToken)}}"
AGENT_STATE="\${AGENT_STATE:-$HOME/.chatview-agent/state.json}"

mkdir -p "$APP_DIR"

cat > "$SCRIPT_PATH" <<'${delimiter}'
${agentBundle}
${delimiter}

if [ ! -x "$BUN_BIN" ]; then
  echo "Installing Bun..."
  curl -fsSL https://bun.com/install | bash
fi

BUN_INSTALL_DIR="\${BUN_INSTALL:-$HOME/.bun}"
BUN_BIN="$BUN_INSTALL_DIR/bin/bun"

if [ ! -x "$BUN_BIN" ]; then
  echo "Bun is not available at $BUN_BIN" >&2
  exit 1
fi

export BACKEND_URL
export AGENT_TOKEN
export AGENT_STATE

echo "Installing Chatview launch agent..."
"$BUN_BIN" "$SCRIPT_PATH" install-launch-agent --backend "$BACKEND_URL" --token "$AGENT_TOKEN"

PLIST_PATH="$HOME/Library/LaunchAgents/com.chatview.agent.plist"
launchctl bootout "gui/$(id -u)" com.chatview.agent >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/com.chatview.agent" >/dev/null 2>&1 || true

echo "Running first sync..."
"$BUN_BIN" "$SCRIPT_PATH" scan-once || true

cat <<EOF

Chatview Agent is installed.
Backend: $BACKEND_URL
State:   $AGENT_STATE
Logs:
  ~/Library/Logs/chatview-agent.log
  ~/Library/Logs/chatview-agent.err.log
EOF
`;
}

function renderReadme(publicUrl: string) {
  return `Chatview Agent for macOS

1. Extract this archive.
2. Double-click ${INSTALLER_NAME}.
3. If macOS blocks the script on first run, right-click it and choose Open.

The installer already includes:
- Backend URL: ${publicUrl}
- An embedded ingest token

You can override them temporarily before running:
- BACKEND_URL
- AGENT_TOKEN
- AGENT_STATE
`;
}

function escapeDoubleQuotedShell(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function createTarArchive(files: { name: string; mode: number; content: string }[]) {
  const chunks: Buffer[] = [];

  for (const file of files) {
    const content = Buffer.from(file.content, "utf8");
    const header = createTarHeader({
      name: file.name,
      mode: file.mode,
      size: content.length,
      mtime: Math.floor(Date.now() / 1000),
    });
    chunks.push(header, content);

    const remainder = content.length % 512;
    if (remainder) chunks.push(Buffer.alloc(512 - remainder));
  }

  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function createTarHeader({
  name,
  mode,
  size,
  mtime,
}: {
  name: string;
  mode: number;
  size: number;
  mtime: number;
}) {
  const header = Buffer.alloc(512, 0);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "wheel");

  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  const value = checksum.toString(8).padStart(6, "0");
  writeString(header, 148, 8, `${value}\0 `);

  return header;
}

function writeString(buffer: Buffer, offset: number, length: number, value: string) {
  buffer.write(value.slice(0, length), offset, length, "utf8");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number) {
  const octal = value.toString(8).padStart(length - 1, "0");
  writeString(buffer, offset, length, `${octal}\0`);
}
