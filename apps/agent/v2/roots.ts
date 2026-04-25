import { envValue, type EnvSource } from "../../../packages/shared/env";
import { defaultSyncRoots } from "./inventory";
import type { ProviderKind, SyncRootConfig } from "./types";

const PROVIDERS = new Set<ProviderKind>(["claude", "codex", "gemini"]);

export function parseRootSpec(value: string | undefined): SyncRootConfig | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const equalsIndex = trimmed.indexOf("=");
  const colonIndex = trimmed.indexOf(":");
  const separatorIndex = equalsIndex >= 0 ? equalsIndex : colonIndex;
  if (separatorIndex <= 0) return undefined;

  const provider = trimmed.slice(0, separatorIndex);
  const rootPath = trimmed.slice(separatorIndex + 1);
  if (isProvider(provider) && rootPath) return { provider, rootPath };
  return undefined;
}

export function parseRootSpecList(value: string | undefined): SyncRootConfig[] {
  if (!value) return [];
  return value
    .split(/[\n,;]/)
    .map((entry) => parseRootSpec(entry))
    .filter((entry): entry is SyncRootConfig => !!entry);
}

export function rootsFromEnv(env: EnvSource = process.env): SyncRootConfig[] {
  const explicitRoots = parseRootSpecList(envValue(env, "ROOTS", "SYNC_ROOTS", "CHATVIEW_ROOTS", "CHATVIEW_SYNC_ROOTS"));
  if (explicitRoots.length) return explicitRoots;

  return defaultSyncRoots().map((root) => ({
    ...root,
    rootPath: rootOverride(env, root.provider) ?? root.rootPath,
  }));
}

function rootOverride(env: EnvSource, provider: ProviderKind) {
  if (provider === "claude") {
    return envValue(env, "CLAUDE_ROOT", "CLAUDE_PROJECTS_DIR", "CHATVIEW_CLAUDE_ROOT", "CHATVIEW_CLAUDE_PROJECTS_DIR");
  }
  if (provider === "codex") {
    return envValue(env, "CODEX_ROOT", "CODEX_SESSIONS_DIR", "CHATVIEW_CODEX_ROOT", "CHATVIEW_CODEX_SESSIONS_DIR");
  }
  return envValue(env, "GEMINI_ROOT", "GEMINI_DIR", "CHATVIEW_GEMINI_ROOT", "CHATVIEW_GEMINI_DIR");
}

function isProvider(value: string): value is ProviderKind {
  return PROVIDERS.has(value as ProviderKind);
}
