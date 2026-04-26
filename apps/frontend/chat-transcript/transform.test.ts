import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../packages/shared/types";
import { flatten, groupItems } from "./transform";

function event(raw: unknown, role?: string): SessionEvent {
  return {
    id: `e-${Math.random()}`,
    sessionDbId: "s1",
    lineNo: 1,
    offset: 0,
    eventType: "message",
    role: role ?? null,
    createdAt: null,
    ingestedAt: "2026-04-26T00:00:00.000Z",
    raw,
  };
}

describe("chat transcript transform", () => {
  test("keeps legacy Claude message markdown as text parts", () => {
    expect(
      flatten([
        event({
          type: "assistant",
          message: { role: "assistant", content: "**Done**\n\n- one\n- two" },
        }),
      ]),
    ).toEqual([{ kind: "text", role: "assistant", text: "**Done**\n\n- one\n- two" }]);
  });

  test("renders normalized v2 parts when legacy message shape is missing", () => {
    const flat = flatten([
      event(
        {
          type: "message",
          normalized: {
            role: "assistant",
            display: true,
            parts: [
              { kind: "thinking", text: "checking" },
              { kind: "text", text: "## Answer" },
              { kind: "tool_call", id: "call-1", name: "Bash", input: { command: "pwd" } },
              { kind: "tool_result", id: "call-1", content: "/repo" },
            ],
          },
        },
        "assistant",
      ),
    ]);

    expect(flat).toEqual([
      { kind: "thinking", text: "checking" },
      { kind: "text", role: "assistant", text: "## Answer" },
      { kind: "tool_use", id: "call-1", name: "Bash", input: { command: "pwd" } },
      { kind: "tool_result", id: "call-1", content: "/repo", isError: undefined },
    ]);
    expect(groupItems(flat).at(-1)).toMatchObject({ kind: "tool_group" });
  });

  test("hides Codex event_msg echoes when the adjacent response_item has the same text", () => {
    const flat = flatten([
      event({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Done:\n\n- one\n- two" }] },
        normalized: {
          role: "assistant",
          display: true,
          parts: [{ kind: "text", text: "Done:\n\n- one\n- two" }],
          source: { provider: "codex", rawType: "event_msg", rawKind: "agent_message" },
        },
      }),
      event({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Done:\n\n- one\n- two" }] },
        normalized: {
          role: "assistant",
          display: true,
          parts: [{ kind: "text", text: "Done:\n\n- one\n- two" }],
          source: { provider: "codex", rawType: "response_item", rawKind: "message" },
        },
      }),
      event({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Older event-msg-only record" }] },
        normalized: {
          role: "assistant",
          display: true,
          parts: [{ kind: "text", text: "Older event-msg-only record" }],
          source: { provider: "codex", rawType: "event_msg", rawKind: "agent_message" },
        },
      }),
    ]);

    expect(flat).toEqual([
      { kind: "text", role: "assistant", text: "Done:\n\n- one\n- two" },
      { kind: "text", role: "assistant", text: "Older event-msg-only record" },
    ]);
  });

  test("unwraps Codex subagent notification JSON before markdown rendering", () => {
    const flat = flatten([
      event({
        type: "assistant",
        message: {
          role: "assistant",
          content:
            '<subagent_notification> {"agent_path":"","status":{"completed":"Проверил.\\n\\n**Затронуто**\\n- `sync.ts`"}}',
        },
      }),
    ]);

    expect(flat).toEqual([{ kind: "text", role: "assistant", text: "Проверил.\n\n**Затронуто**\n- `sync.ts`" }]);
  });
});
