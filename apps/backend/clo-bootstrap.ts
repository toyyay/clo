import { createHash, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { envValue } from "../../packages/shared/env";
import { inlineContentDisposition } from "./http-headers";

const DEFAULT_PUBLIC_URL = "https://clo.vf.lc";
const DEFAULT_UPDATE_TOKEN = "clo-home-update-v1";
const AGENT_ENTRYPOINT = new URL("../agent/main.ts", import.meta.url).pathname;
const RUNNER_ENTRYPOINT = new URL("../agent/clo.ts", import.meta.url).pathname;

type CloArtifact = {
  bytes: Buffer;
  sha256: string;
};

const agentArtifacts = new Map<string, Promise<CloArtifact>>();
const runnerArtifacts = new Map<string, Promise<CloArtifact>>();

export async function cloManifestResponse(req: Request, agentToken: string, env = process.env) {
  const auth = requireCloUpdateAuth(req, env);
  if (auth) return auth;
  const publicUrl = publicUrlFor(env);
  const artifact = await loadCloAgentArtifact(publicUrl, agentToken, env);
  return Response.json({
    name: "clo-agent",
    version: versionFor(env),
    bundleUrl: `${publicUrl}/clo/clo-agent.js`,
    sha256: artifact.sha256,
    sizeBytes: artifact.bytes.byteLength,
    pollMs: 60_000,
    minRunnerVersion: "1",
  });
}

export async function cloAgentBundleResponse(req: Request, agentToken: string, env = process.env) {
  const auth = requireCloUpdateAuth(req, env);
  if (auth) return auth;
  const artifact = await loadCloAgentArtifact(publicUrlFor(env), agentToken, env);
  return javascriptResponse(artifact.bytes, "clo-agent.js");
}

export async function cloRunnerResponse(req: Request, env = process.env) {
  const auth = requireCloUpdateAuth(req, env);
  if (auth) return auth;
  const artifact = await loadCloRunnerArtifact(publicUrlFor(env), updateTokenFor(env), env);
  return javascriptResponse(artifact.bytes, "clo");
}

export function cloInstallScriptResponse(req: Request, env = process.env) {
  const auth = requireCloUpdateAuth(req, env);
  if (auth) return auth;
  const publicUrl = publicUrlFor(env);
  const token = updateTokenFor(env);
  const body = `#!/usr/bin/env bash
set -euo pipefail

BUN_BIN="\${BUN_BIN:-$(command -v bun || true)}"
if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN_BIN" ]; then
  echo "clo needs bun in PATH" >&2
  exit 1
fi

CLO_HOME="\${CLO_HOME:-$HOME/.clo}"
CLO_HOSTNAME="\${CLO_HOSTNAME:-$(hostname)}"
mkdir -p "$CLO_HOME/bin" "$HOME/.config/clo" "$HOME/.config/systemd/user"

curl -fsSL -H "Authorization: Bearer ${shellQuote(token)}" "${publicUrl}/clo/clo.js" -o "$CLO_HOME/bin/clo"
chmod 700 "$CLO_HOME/bin/clo"

cat > "$HOME/.config/clo/env" <<ENV
CLO_HOSTNAME=$CLO_HOSTNAME
ENV
chmod 600 "$HOME/.config/clo/env"

cat > "$HOME/.config/systemd/user/clo.service" <<UNIT
[Unit]
Description=Clo self-updating agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-%h/.config/clo/env
ExecStart=$BUN_BIN %h/.clo/bin/clo run
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now clo.service
systemctl --user restart clo.service
systemctl --user --no-pager --full status clo.service
`;
  return new Response(body, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
    },
  });
}

export function requireCloUpdateAuth(req: Request, env = process.env) {
  const expected = updateTokenFor(env);
  const auth = req.headers.get("authorization") ?? "";
  const urlToken = new URL(req.url).searchParams.get("token") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  return tokenMatches(bearer, expected) || tokenMatches(urlToken, expected) ? null : text("unauthorized", 401);
}

async function loadCloAgentArtifact(publicUrl: string, agentToken: string, env: NodeJS.ProcessEnv) {
  const cacheKey = [versionFor(env), publicUrl, tokenHash(agentToken)].join(":");
  let promise = agentArtifacts.get(cacheKey);
  if (!promise) {
    promise = buildBundle({
      entrypoint: AGENT_ENTRYPOINT,
      defines: {
        CHATVIEW_EMBEDDED_BACKEND_URL: publicUrl,
        CHATVIEW_EMBEDDED_AGENT_TOKEN: agentToken,
        CHATVIEW_DEFAULT_COMMAND: "run",
      },
    });
    agentArtifacts.set(cacheKey, promise);
  }
  return promise;
}

async function loadCloRunnerArtifact(publicUrl: string, updateToken: string, env: NodeJS.ProcessEnv) {
  const cacheKey = [versionFor(env), publicUrl, tokenHash(updateToken)].join(":");
  let promise = runnerArtifacts.get(cacheKey);
  if (!promise) {
    promise = buildBundle({
      entrypoint: RUNNER_ENTRYPOINT,
      defines: {
        CLO_EMBEDDED_BASE_URL: publicUrl,
        CLO_EMBEDDED_UPDATE_TOKEN: updateToken,
      },
    });
    runnerArtifacts.set(cacheKey, promise);
  }
  return promise;
}

async function buildBundle({ entrypoint, defines }: { entrypoint: string; defines: Record<string, string> }) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
    define: Object.fromEntries(Object.entries(defines).map(([key, value]) => [key, JSON.stringify(value)])),
  });
  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join("\n");
    throw new Error(`failed to build clo bundle${logs ? `:\n${logs}` : ""}`);
  }
  const output = result.outputs.find((item) => item.kind === "entry-point");
  if (!output) throw new Error("clo bundle did not produce an entry point");
  const bytes = Buffer.from(`#!/usr/bin/env bun\n${await output.text()}`, "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function publicUrlFor(env: NodeJS.ProcessEnv) {
  return trimSlash(envValue(env, "PUBLIC_URL", "CLO_PUBLIC_URL", "BACKEND_URL", "CHATVIEW_BACKEND_URL") ?? DEFAULT_PUBLIC_URL);
}

function updateTokenFor(env: NodeJS.ProcessEnv) {
  return envValue(env, "CLO_UPDATE_TOKEN", "CHATVIEW_UPDATE_TOKEN") ?? DEFAULT_UPDATE_TOKEN;
}

function versionFor(env: NodeJS.ProcessEnv) {
  return env.GIT_SHA ?? "dev";
}

function javascriptResponse(bytes: Uint8Array, filename: string) {
  return new Response(toArrayBuffer(bytes), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "content-disposition": inlineContentDisposition(filename) ?? "inline",
      "cache-control": "private, no-store, max-age=0",
    },
  });
}

function tokenMatches(value: string, expected: string) {
  if (!value || !expected) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function toArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function shellQuote(value: string) {
  return value.replaceAll("'", "'\\''");
}

function text(value: string, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
