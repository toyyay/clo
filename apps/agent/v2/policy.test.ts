import { describe, expect, test } from "bun:test";
import { fetchServerSyncPolicy, normalizeServerPolicy } from "./policy";
import type { AgentV2Identity } from "./types";

const identity: AgentV2Identity = {
  agentId: "agent-test",
  hostname: "workstation",
  platform: "darwin",
  arch: "arm64",
  version: "test",
};

describe("agent-v2 policy", () => {
  test("fetches the backend v1 hello endpoint", async () => {
    const seenUrls: string[] = [];
    const policy = await fetchServerSyncPolicy({
      backendUrl: "http://example.test/",
      token: "token",
      identity,
      fetchImpl: (async (url) => {
        seenUrls.push(String(url));
        return Response.json({
          ok: true,
          policy: {
            enabled: true,
            uploadsEnabled: true,
            maxFileBytes: 1234,
            maxUploadLines: 12,
            requestLimits: { rawChunkBytes: 456 },
            providers: ["claude", "codex", "unknown"],
            ignorePatterns: ["auth.json"],
          },
        });
      }) as typeof fetch,
    });

    expect(seenUrls).toEqual(["http://example.test/api/agent/v1/hello"]);
    expect(policy.source).toBe("server");
    expect(policy.uploadsEnabled).toBe(true);
    expect(policy.maxUploadChunkBytes).toBe(456);
    expect(policy.maxUploadLines).toBe(12);
    expect(policy.scanRoots).toEqual(["claude", "codex"]);
    expect(policy.ignorePatterns).toEqual(["auth.json"]);
  });

  test("normalizes protocol-shaped backend policies", () => {
    const policy = normalizeServerPolicy({
      requestLimits: { rawChunkBytes: 789 },
      providers: ["gemini", "path"],
    });

    expect(policy.maxUploadChunkBytes).toBe(789);
    expect(policy.scanRoots).toEqual(["gemini"]);
  });
});
