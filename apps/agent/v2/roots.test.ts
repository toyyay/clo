import { describe, expect, test } from "bun:test";
import { parseRootSpecList, rootsFromEnv } from "./roots";

describe("agent-v2 roots", () => {
  test("parses multiple root specs from env-style lists", () => {
    expect(parseRootSpecList("claude=/tmp/claude,codex:/tmp/codex\ngemini=/tmp/gemini")).toEqual([
      { provider: "claude", rootPath: "/tmp/claude" },
      { provider: "codex", rootPath: "/tmp/codex" },
      { provider: "gemini", rootPath: "/tmp/gemini" },
    ]);
  });

  test("uses ROOTS as explicit roots and provider env vars as default overrides", () => {
    expect(rootsFromEnv({ ROOTS: "claude=/custom/claude;codex=/custom/codex" })).toEqual([
      { provider: "claude", rootPath: "/custom/claude" },
      { provider: "codex", rootPath: "/custom/codex" },
    ]);

    const roots = rootsFromEnv({ CLAUDE_ROOT: "/override/claude" });
    expect(roots.find((root) => root.provider === "claude")?.rootPath).toBe("/override/claude");
    expect(roots.find((root) => root.provider === "codex")?.rootPath).toContain(".codex");
  });
});
