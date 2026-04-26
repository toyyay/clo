import type { SessionEvent } from "../../../packages/shared/types";
import type { FlatPart, RenderItem, TextPart, ToolGroup } from "./types";

export function flatten(events: SessionEvent[]): FlatPart[] {
  const out: FlatPart[] = [];
  for (const event of events) {
    const raw = event.raw as any;
    if (appendLegacyMessage(out, raw)) continue;
    if (appendNormalizedEvent(out, raw?.normalized, event)) continue;
    appendNormalizedEvent(out, raw, event);
  }
  return out;
}

function appendLegacyMessage(out: FlatPart[], value: any) {
  if (!value || (value.type !== "user" && value.type !== "assistant")) return false;
  const message = value.message;
  const role = normalizedTextRole(message?.role ?? value.type);
  if (!message || !role) return false;
  const before = out.length;
  appendContent(out, role, message.content);
  return out.length > before;
}

function appendNormalizedEvent(out: FlatPart[], value: any, event: SessionEvent) {
  if (!value || typeof value !== "object" || value.display === false) return false;
  const role = normalizedTextRole(value.role ?? event.role);
  const before = out.length;
  appendContent(out, role, value.parts ?? value.content ?? value.text ?? value.message);
  return out.length > before;
}

function appendContent(out: FlatPart[], role: TextPart["role"] | null, content: unknown) {
  if (typeof content === "string") {
    if (role && content.trim()) out.push({ kind: "text", role, text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) appendContentPart(out, role, part);
}

function appendContentPart(out: FlatPart[], role: TextPart["role"] | null, value: any) {
  if (typeof value === "string") {
    if (role && value.trim()) out.push({ kind: "text", role, text: value });
    return;
  }
  if (!value || typeof value !== "object") return;
  const kind = String(value.kind ?? value.type ?? "").toLowerCase();
  if ((kind === "text" || kind === "input_text" || kind === "output_text" || kind === "summary_text") && role && value.text?.trim()) {
    out.push({ kind: "text", role, text: value.text });
  } else if (kind === "thinking" || kind === "reasoning" || kind === "reasoning_text") {
    const thinking = value.thinking ?? value.text ?? value.content;
    if (typeof thinking === "string" && thinking.trim()) out.push({ kind: "thinking", text: thinking });
  } else if (kind === "tool_call" || kind === "tool_use" || kind === "function_call" || kind === "server_tool_use") {
    out.push({
      kind: "tool_use",
      name: value.name ?? value.tool_name ?? kind,
      input: value.input ?? value.arguments ?? value.parameters ?? {},
      id: value.id ?? value.tool_use_id ?? value.call_id ?? `${kind}:${out.length}`,
    });
  } else if (kind === "tool_result" || kind === "function_call_output" || kind === "tool_output") {
    out.push({
      kind: "tool_result",
      content: value.content ?? value.output ?? value.result ?? "",
      isError: value.is_error ?? value.isError,
      id: value.tool_use_id ?? value.id ?? value.call_id ?? `result:${out.length}`,
    });
  } else if (Array.isArray(value.content)) {
    appendContent(out, role, value.content);
  } else if (typeof value.text === "string" && role && value.text.trim()) {
    out.push({ kind: "text", role, text: value.text });
  }
}

function normalizedTextRole(value: unknown): TextPart["role"] | null {
  const role = String(value ?? "").toLowerCase();
  if (role === "assistant") return "assistant";
  if (role === "user" || role === "tool") return "user";
  return null;
}

export function groupItems(flat: FlatPart[]): RenderItem[] {
  const out: RenderItem[] = [];
  let cur: ToolGroup | null = null;
  for (const p of flat) {
    if (p.kind === "tool_use" || p.kind === "tool_result") {
      if (!cur) {
        cur = { kind: "tool_group", uses: [], results: [] };
        out.push(cur);
      }
      if (p.kind === "tool_use") cur.uses.push(p);
      else cur.results.push(p);
    } else {
      cur = null;
      out.push(p);
    }
  }
  return out;
}
