import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { matchesPolicyPath } from "../../../packages/sync-core";
import type { InventoryFile, ProviderKind, SyncRootConfig } from "./types";

const DEFAULT_PROVIDER_ROOTS: Record<ProviderKind, string> = {
  claude: join(homedir(), ".claude", "projects"),
  codex: join(homedir(), ".codex", "sessions"),
  gemini: join(homedir(), ".gemini"),
};

export function defaultSyncRoots(): SyncRootConfig[] {
  return (Object.entries(DEFAULT_PROVIDER_ROOTS) as Array<[ProviderKind, string]>).map(([provider, rootPath]) => ({
    provider,
    rootPath,
  }));
}

export async function scanInventory(roots: SyncRootConfig[], globalIgnorePatterns: string[] = []): Promise<InventoryFile[]> {
  const files: InventoryFile[] = [];

  for (const root of roots) {
    const rootStat = await stat(root.rootPath).catch(() => undefined);
    if (!rootStat?.isDirectory()) continue;

    const ignorePatterns = [...globalIgnorePatterns, ...(root.ignorePatterns ?? [])];
    await walkRoot(root, root.rootPath, ignorePatterns, files);
  }

  files.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return files;
}

async function walkRoot(root: SyncRootConfig, dir: string, ignorePatterns: string[], out: InventoryFile[]) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const sourcePath = join(dir, entry.name);
    const relativePath = relative(root.rootPath, sourcePath).split(sep).join("/");
    if (matchesIgnore(entry.name, ignorePatterns, relativePath, sourcePath)) continue;
    if (entry.isDirectory()) {
      await walkRoot(root, sourcePath, ignorePatterns, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

    const fileStat = await stat(sourcePath).catch(() => undefined);
    if (!fileStat?.isFile()) continue;
    out.push({
      provider: root.provider,
      sourcePath,
      relativePath,
      sizeBytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      dev: fileStat.dev,
      ino: fileStat.ino,
      logicalId: `${root.provider}:${relativePath}`,
      ...deriveProviderFields(root.provider, relativePath),
    });
  }
}

export function matchesIgnore(name: string, patterns: string[], relativePath = name, sourcePath = relativePath): boolean {
  return patterns.some((pattern) => {
    if (!pattern) return false;
    if (pattern === name) return true;
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
    if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
    if (matchesPolicyPath(relativePath, pattern)) return true;
    if (matchesPolicyPath(sourcePath, pattern)) return true;
    return false;
  });
}

function deriveProviderFields(provider: ProviderKind, relativePath: string) {
  const parts = relativePath.split("/");
  const fileName = basename(relativePath);
  const sessionId = fileName.replace(/\.jsonl$/, "");
  if (provider === "claude") {
    return {
      projectKey: parts.length > 1 ? parts[0] : undefined,
      sessionId,
    };
  }
  return { sessionId };
}
