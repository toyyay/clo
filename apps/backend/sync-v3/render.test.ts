import { describe, expect, test } from "bun:test";
import { eventToRenderRows } from "./render";

describe("eventToRenderRows", () => {
  test("legacy claude user message", () => {
    const rows = eventToRenderRows({
      id: 1,
      role: "user",
      eventType: "message",
      raw: { type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      normalized: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("t");
    expect(rows[0].display).toBe(true);
    expect((rows[0].payload as any).r).toBe("u");
    expect((rows[0].payload as any).txt).toBe("hello");
  });

  test("legacy claude assistant text", () => {
    const rows = eventToRenderRows({
      id: 2,
      raw: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "world" }] } },
    });
    expect(rows[0].kind).toBe("t");
    expect((rows[0].payload as any).r).toBe("a");
  });

  test("normalized text part", () => {
    const rows = eventToRenderRows({
      id: 3,
      normalized: {
        kind: "message",
        role: "assistant",
        display: true,
        parts: [{ kind: "text", text: "from normalized" }],
      },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as any).txt).toBe("from normalized");
  });

  test("display:false → single hidden row", () => {
    const rows = eventToRenderRows({
      id: 4,
      normalized: { kind: "event", role: "system", display: false, parts: [] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].display).toBe(false);
    expect(rows[0].payload_bytes).toBe(0);
  });

  test("thinking part", () => {
    const rows = eventToRenderRows({
      id: 5,
      normalized: {
        kind: "message",
        role: "assistant",
        display: true,
        parts: [{ kind: "thinking", thinking: "considering options..." }],
      },
    });
    expect(rows[0].kind).toBe("th");
    expect((rows[0].payload as any).txt).toBe("considering options...");
  });

  test("tool_use + tool_result", () => {
    const useRows = eventToRenderRows({
      id: 6,
      normalized: {
        kind: "message",
        role: "assistant",
        display: true,
        parts: [{ kind: "tool_use", name: "bash", id: "tool_42", input: { cmd: "ls" } }],
      },
    });
    expect(useRows[0].kind).toBe("tu");
    expect(useRows[0].tool_id).toBe("tool_42");
    expect((useRows[0].payload as any).name).toBe("bash");

    const resRows = eventToRenderRows({
      id: 7,
      normalized: {
        kind: "message",
        role: "user",
        display: true,
        parts: [{ kind: "tool_result", tool_use_id: "tool_42", content: "drwxr-xr-x" }],
      },
    });
    expect(resRows[0].kind).toBe("tr");
    expect(resRows[0].tool_id).toBe("tool_42");
    expect((resRows[0].payload as any).out).toBe("drwxr-xr-x");
  });

  test("tool_result truncation", () => {
    const big = "x".repeat(10_000);
    const rows = eventToRenderRows({
      id: 8,
      normalized: {
        kind: "message",
        role: "user",
        display: true,
        parts: [{ kind: "tool_result", tool_use_id: "tool_43", content: big }],
      },
    });
    expect(rows[0].kind).toBe("tr");
    expect((rows[0].payload as any).trunc).toBe(true);
    expect((rows[0].payload as any).out.length).toBe(4096);
  });

  test("multi-part text+thinking+tool", () => {
    const rows = eventToRenderRows({
      id: 9,
      normalized: {
        kind: "message",
        role: "assistant",
        display: true,
        parts: [
          { kind: "text", text: "thinking..." },
          { kind: "thinking", thinking: "deep" },
          { kind: "tool_use", name: "ls", id: "t1", input: {} },
        ],
      },
    });
    expect(rows.map((r) => r.kind)).toEqual(["t", "th", "tu"]);
    expect(rows.map((r) => r.part_index)).toEqual([0, 1, 2]);
  });

  test("payload_bytes is reasonable", () => {
    const rows = eventToRenderRows({
      id: 10,
      normalized: { kind: "message", role: "user", display: true, parts: [{ kind: "text", text: "hi" }] },
    });
    expect(rows[0].payload_bytes).toBeGreaterThan(0);
    expect(rows[0].payload_bytes).toBeLessThan(120);
  });

  test("codex subagent_notification → readable status", () => {
    const rows = eventToRenderRows({
      id: 11,
      normalized: {
        kind: "message",
        role: "assistant",
        display: true,
        parts: [{ kind: "text", text: '<subagent_notification>{"status":"completed"}' }],
      },
    });
    expect((rows[0].payload as any).txt).toBe("completed");
  });
});
