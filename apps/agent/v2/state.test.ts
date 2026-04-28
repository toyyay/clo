import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { identityForAgentV2, loadAgentV2State, saveAgentV2State } from "./state";

describe("agent-v2 state", () => {
  test("backs up corrupt state and preserves agentId when possible", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-state-corrupt-"));
    const statePath = join(dir, "v2.json");
    const raw = "{\"agentId\":\"agent-keep\",\"cursors\":";
    await writeFile(statePath, raw);

    const state = await loadAgentV2State(statePath);
    const entries = await readdir(dir);
    const backupName = entries.find((entry) => entry.startsWith("v2.json.corrupt-") && entry.endsWith(".bak"));

    expect(state.agentId).toBe("agent-keep");
    expect(state.cursors).toEqual({});
    expect(backupName).toBeTruthy();
    expect(await readFile(join(dir, backupName!), "utf8")).toBe(raw);
    expect(await readFile(statePath, "utf8").catch(() => "")).toBe("");
  });

  test("saves state atomically and leaves no temp files behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatview-agent-v2-state-save-"));
    const statePath = join(dir, "nested", "v2.json");

    await saveAgentV2State(statePath, {
      agentId: "agent-save",
      cursors: {
        "/tmp/session.jsonl": {
          generation: 1,
          offset: 2,
          lineNo: 1,
          sizeBytes: 2,
          mtimeMs: 1,
        },
      },
    });

    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    const entries = await readdir(join(dir, "nested"));

    expect(parsed.agentId).toBe("agent-save");
    expect(parsed.cursors["/tmp/session.jsonl"].offset).toBe(2);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  test("adds runtime metadata to agent identity", () => {
    const identity = identityForAgentV2({ agentId: "agent-runtime", cursors: {} });

    expect(identity.agentId).toBe("agent-runtime");
    expect(identity.runtimeId).toBeTruthy();
    expect(identity.pid).toBe(process.pid);
    expect(Date.parse(identity.startedAt)).not.toBeNaN();
  });
});
