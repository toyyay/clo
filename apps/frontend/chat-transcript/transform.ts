import type { SessionEvent } from "../../../packages/shared/types";
import type { FlatPart, RenderItem, TextPart, ToolGroup } from "./types";

export function flatten(events: SessionEvent[]): FlatPart[] {
  const out: FlatPart[] = [];
  const entries = events.map((event) => ({ event, raw: event.raw as any, parts: flattenEvent(event) }));
  for (let i = 0; i < entries.length; i += 1) {
    if (isCodexMessageEcho(entries[i], entries[i - 1]) || isCodexMessageEcho(entries[i], entries[i + 1])) continue;
    out.push(...entries[i].parts);
  }
  return out;
}

function flattenEvent(event: SessionEvent): FlatPart[] {
  const out: FlatPart[] = [];
  const raw = event.raw as any;
  if (appendLegacyMessage(out, raw)) return out;
  if (appendNormalizedEvent(out, raw?.normalized, event)) return out;
  appendNormalizedEvent(out, raw, event);
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
    appendText(out, role, content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) appendContentPart(out, role, part);
}

function appendContentPart(out: FlatPart[], role: TextPart["role"] | null, value: any) {
  if (typeof value === "string") {
    appendText(out, role, value);
    return;
  }
  if (!value || typeof value !== "object") return;
  const kind = String(value.kind ?? value.type ?? "").toLowerCase();
  if ((kind === "text" || kind === "input_text" || kind === "output_text" || kind === "summary_text") && role && value.text?.trim()) {
    appendText(out, role, value.text);
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
    appendText(out, role, value.text);
  }
}

function appendText(out: FlatPart[], role: TextPart["role"] | null, text: string) {
  const readable = readableText(text);
  if (role && readable.trim()) out.push({ kind: "text", role, text: readable });
}

function readableText(text: string) {
  return codexNotificationText(text) ?? text;
}

function codexNotificationText(text: string) {
  const trimmed = text.trimStart();
  const tag = "<subagent_notification>";
  if (!trimmed.startsWith(tag)) return null;
  const parsed = parseTaggedJson(trimmed.slice(tag.length).trim());
  if (!parsed) return null;
  return notificationStatusText(parsed) ?? null;
}

function parseTaggedJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
      try {
        return JSON.parse(text.slice(0, end + 1));
      } catch {
        continue;
      }
    }
    return null;
  }
}

function notificationStatusText(value: any): string | undefined {
  const status = value?.status;
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    for (const key of ["completed", "failed", "error", "running", "started"]) {
      if (typeof status[key] === "string") return status[key];
    }
  }
  for (const key of ["message", "text", "summary", "output"]) {
    if (typeof value?.[key] === "string") return value[key];
  }
  return undefined;
}

function normalizedTextRole(value: unknown): TextPart["role"] | null {
  const role = String(value ?? "").toLowerCase();
  if (role === "assistant") return "assistant";
  if (role === "user" || role === "tool") return "user";
  return null;
}

function isCodexMessageEcho(
  entry: { raw: any; parts: FlatPart[] },
  neighbor?: { raw: any; parts: FlatPart[] },
) {
  if (!neighbor) return false;
  const source = rawSource(entry.raw);
  const neighborSource = rawSource(neighbor.raw);
  if (source.provider !== "codex" || neighborSource.provider !== "codex") return false;
  if (source.rawType !== "event_msg" || neighborSource.rawType !== "response_item") return false;
  if (source.rawKind !== "agent_message" && source.rawKind !== "user_message") return false;
  const signature = textPartsSignature(entry.parts);
  return signature !== null && signature === textPartsSignature(neighbor.parts);
}

function rawSource(raw: any) {
  const source = raw?.normalized?.source ?? raw?.source ?? {};
  return {
    provider: String(source.provider ?? "").toLowerCase(),
    rawType: String(source.rawType ?? source.raw_type ?? "").toLowerCase(),
    rawKind: String(source.rawKind ?? source.raw_kind ?? "").toLowerCase(),
  };
}

function textPartsSignature(parts: FlatPart[]) {
  if (!parts.length || !parts.every((part) => part.kind === "text")) return null;
  return JSON.stringify(parts.map((part) => [part.role, part.text]));
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
