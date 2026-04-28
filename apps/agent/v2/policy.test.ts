import { describe, expect, test } from "bun:test";
import { AgentRuntimeRejectedError, AgentShutdownRequestedError, fetchServerSyncPolicy, normalizeServerPolicy } from "./policy";
import type { AgentV2Identity } from "./types";

const identity: AgentV2Identity = {
  agentId: "agent-test",
  hostname: "workstation",
  platform: "darwin",
  arch: "arm64",
  version: "test",
  runtimeId: "runtime-test",
  pid: 123,
  startedAt: "2026-04-25T10:00:00.000Z",
};

describe("agent-v2 policy", () => {
  test("fetches the backend v1 hello endpoint", async () => {
    const seenUrls: string[] = [];
    const policy = await fetchServerSyncPolicy({
      backendUrl: "http://example.test/",
      token: "token",
      identity,
      takeover: true,
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

  test("sends runtime takeover intent to the hello endpoint", async () => {
    let body: any;
    await fetchServerSyncPolicy({
      backendUrl: "http://example.test",
      token: "token",
      identity,
      takeover: true,
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ policy: { enabled: true, uploadsEnabled: false } });
      }) as typeof fetch,
    });

    expect(body.agent.runtimeId).toBe("runtime-test");
    expect(body.runtime).toMatchObject({
      runtimeId: "runtime-test",
      pid: 123,
      startedAt: "2026-04-25T10:00:00.000Z",
      takeover: true,
    });
    expect(body.control).toEqual({ takeover: true });
  });

  test("rejects duplicate active runtimes instead of falling back to defaults", async () => {
    await expect(
      fetchServerSyncPolicy({
        backendUrl: "http://example.test",
        token: "token",
        identity,
        fetchImpl: (async () =>
          Response.json(
            {
              ok: false,
              control: {
                action: "reject",
                reason: "host already has an active agent runtime",
                activeRuntimes: [{ runtimeId: "other", hostname: "workstation", pid: 456 }],
              },
            },
            { status: 409 },
          )) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeRejectedError);
  });

  test("turns server shutdown control into a stop signal", async () => {
    await expect(
      fetchServerSyncPolicy({
        backendUrl: "http://example.test",
        token: "token",
        identity,
        fetchImpl: (async () =>
          Response.json({
            ok: true,
            control: {
              action: "shutdown",
              reason: "replaced by newer runtime",
            },
            policy: {
              enabled: true,
              uploadsEnabled: true,
            },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(AgentShutdownRequestedError);
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
