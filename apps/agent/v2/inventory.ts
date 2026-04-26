import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { matchesPolicyPath } from "../../../packages/sync-core";
import type { AppendJsonlCursor, InventoryFile, ProviderKind, SyncRootConfig } from "./types";

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
    out.push(inventoryFileForPath(root, sourcePath, relativePath, fileStat.size, fileStat.mtimeMs, fileStat.dev, fileStat.ino));
  }
}

export function missingInventoryFilesFromCursors(
  cursors: Record<string, AppendJsonlCursor>,
  roots: SyncRootConfig[],
  activeFiles: InventoryFile[],
): InventoryFile[] {
  const activeSourcePaths = new Set(activeFiles.map((file) => file.sourcePath));
  const missing: InventoryFile[] = [];

  for (const [sourcePath, cursor] of Object.entries(cursors)) {
    if (activeSourcePaths.has(sourcePath)) continue;
    if (!sourcePath.endsWith(".jsonl")) continue;
    const root = roots.find((candidate) => relativePathWithinRoot(candidate.rootPath, sourcePath) != null);
    if (!root) continue;
    const relativePath = relativePathWithinRoot(root.rootPath, sourcePath);
    if (!relativePath) continue;
    missing.push(
      inventoryFileForPath(root, sourcePath, relativePath, cursor.sizeBytes, cursor.mtimeMs, cursor.dev, cursor.ino),
    );
  }

  return missing.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
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

function inventoryFileForPath(
  root: SyncRootConfig,
  sourcePath: string,
  relativePath: string,
  sizeBytes: number,
  mtimeMs: number,
  dev?: number,
  ino?: number,
): InventoryFile {
  return {
    provider: root.provider,
    sourcePath,
    relativePath,
    sizeBytes,
    mtimeMs,
    dev,
    ino,
    logicalId: `${root.provider}:${relativePath}`,
    ...deriveProviderFields(root.provider, relativePath),
  };
}

function relativePathWithinRoot(rootPath: string, sourcePath: string) {
  const nativeRelative = relative(rootPath, sourcePath);
  if (!nativeRelative || nativeRelative === ".." || nativeRelative.startsWith(`..${sep}`)) return null;
  return nativeRelative.split(sep).join("/");
}
