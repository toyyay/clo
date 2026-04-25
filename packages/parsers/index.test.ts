import { describe, expect, test } from "bun:test";
import { normalizeJsonlTranscript, normalizeTranscriptRecord } from "./index";

describe("transcript normalizers", () => {
  test("normalizes Claude JSONL user and assistant message content", () => {
    const user = normalizeTranscriptRecord(
      {
        type: "user",
        timestamp: "2026-04-25T10:00:00.000Z",
        message: {
          role: "user",
          content: "hello Claude",
        },
      },
      { provider: "claude", sourcePath: "/logs/claude/session.jsonl", lineNo: 1, byteOffset: 0 },
    );

    expect(user).toMatchObject({
      kind: "message",
      role: "user",
      timestamp: "2026-04-25T10:00:00.000Z",
      display: true,
      source: {
        provider: "claude",
        sourcePath: "/logs/claude/session.jsonl",
        lineNo: 1,
        byteOffset: 0,
        rawType: "user",
        rawKind: "user",
      },
      parts: [{ kind: "text", text: "hello Claude" }],
    });

    const assistant = normalizeTranscriptRecord(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "checking files" },
            { type: "text", text: "done" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      },
      { provider: "claude" },
    );

    expect(assistant.kind).toBe("message");
    expect(assistant.role).toBe("assistant");
    expect(assistant.parts).toEqual([
      { kind: "thinking", text: "checking files" },
      { kind: "text", text: "done" },
      { kind: "tool_call", id: "toolu_1", name: "Read", input: { file_path: "README.md" } },
    ]);
  });

  test("normalizes Claude tool results from user content arrays", () => {
    const event = normalizeTranscriptRecord(
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body", is_error: false }],
        },
      },
      { provider: "claude" },
    );

    expect(event).toMatchObject({
      kind: "tool_result",
      role: "user",
      display: true,
      parts: [{ kind: "tool_result", id: "toolu_1", content: "file body", isError: false }],
    });
  });

  test("normalizes Codex user and assistant records", () => {
    const user = normalizeTranscriptRecord(
      {
        type: "user_message",
        timestamp: "2026-04-25T11:00:00.000Z",
        message: "please inspect this",
      },
      { provider: "codex", sourcePath: "/logs/codex/history.jsonl", lineNo: 3 },
    );

    expect(user).toMatchObject({
      kind: "message",
      role: "user",
      timestamp: "2026-04-25T11:00:00.000Z",
      display: true,
      source: { provider: "codex", rawType: "user_message", rawKind: "user_message", lineNo: 3 },
      parts: [{ kind: "text", text: "please inspect this" }],
    });

    const assistant = normalizeTranscriptRecord(
      {
        type: "response_item",
        item: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "I found it." },
            { type: "reasoning_text", text: "Synthetic hidden-ish reasoning summary" },
          ],
        },
      },
      { provider: "codex" },
    );

    expect(assistant).toMatchObject({
      kind: "message",
      role: "assistant",
      display: true,
      source: { provider: "codex", rawType: "response_item", rawKind: "message" },
      parts: [
        { kind: "text", text: "I found it." },
        { kind: "thinking", text: "Synthetic hidden-ish reasoning summary" },
      ],
    });
  });

  test("normalizes Codex tool calls and tool outputs", () => {
    const call = normalizeTranscriptRecord(
      {
        type: "response_item",
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: '{"cmd":"rg parser"}',
        },
      },
      { provider: "codex" },
    );

    expect(call).toMatchObject({
      kind: "tool_call",
      role: "tool",
      display: true,
      parts: [{ kind: "tool_call", id: "call_1", name: "shell", input: { cmd: "rg parser" } }],
    });

    const output = normalizeTranscriptRecord(
      {
        type: "exec_command_output_delta",
        call_id: "call_1",
        output: "packages/parsers/index.ts",
      },
      { provider: "codex" },
    );

    expect(output).toMatchObject({
      kind: "tool_result",
      role: "tool",
      display: true,
      parts: [{ kind: "tool_result", id: "call_1", content: "packages/parsers/index.ts" }],
    });
  });

  test("keeps Codex session and unknown records non-display without throwing", () => {
    const session = normalizeTranscriptRecord(
      {
        type: "session_configured",
        session_id: "sess_1",
        model: "gpt-5",
      },
      { provider: "codex" },
    );

    expect(session).toMatchObject({
      kind: "session",
      role: "system",
      display: false,
      source: { provider: "codex", rawType: "session_configured", rawKind: "session_configured" },
    });

    const unknown = normalizeTranscriptRecord({ type: "surprise_record", payload: { ok: true } }, { provider: "codex" });
    expect(unknown).toMatchObject({
      kind: "event",
      role: "system",
      display: false,
      parts: [{ kind: "event", name: "surprise_record", data: { payload: { ok: true } } }],
      source: { provider: "codex", rawType: "surprise_record", rawKind: "surprise_record" },
    });
  });

  test("normalizes top-level Codex reasoning summaries as thinking", () => {
    const event = normalizeTranscriptRecord(
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "brief chain summary" }],
      },
      { provider: "codex" },
    );

    expect(event.kind).toBe("thinking");
    expect(event.parts).toEqual([{ kind: "thinking", text: "brief chain summary" }]);
  });

  test("parses JSONL with line numbers, UTF-8 byte offsets, and diagnostics", () => {
    const first = JSON.stringify({ type: "user_message", message: "привет" });
    const second = "{bad json";
    const third = JSON.stringify({ type: "agent_message", message: "ok" });
    const jsonl = `${first}\n${second}\n${third}`;

    const result = normalizeJsonlTranscript(jsonl, { provider: "codex", sourcePath: "/logs/codex/history.jsonl" });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ lineNo: 2, byteOffset: new TextEncoder().encode(`${first}\n`).byteLength });
    expect(result.events).toHaveLength(3);
    expect(result.events[0].source).toMatchObject({ lineNo: 1, byteOffset: 0 });
    expect(result.events[1]).toMatchObject({
      kind: "event",
      role: "system",
      display: false,
      source: { provider: "codex", lineNo: 2, rawType: "invalid_json", rawKind: "invalid_json" },
    });
    expect(result.events[2]).toMatchObject({
      kind: "message",
      role: "assistant",
      parts: [{ kind: "text", text: "ok" }],
      source: { lineNo: 3 },
    });
  });
});
