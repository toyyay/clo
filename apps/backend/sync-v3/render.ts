// Server-side rendering pipeline.
//
// Берёт normalized event (тот что в agent_normalized_events.normalized) и
// раскладывает его в массив RenderItem'ов, готовых к рендеру клиентом.
//
// Логика — порт apps/frontend/chat-transcript/transform.ts:
//   • appendLegacyMessage   — { type: "user"|"assistant", message: { role, content } }
//   • appendNormalizedEvent — { display, role, parts }
//   • appendContent / appendContentPart — рекурсия по nested content
//   • text/thinking/tool_use/tool_result — четыре kind'а
//   • codexNotificationText — извлечение читаемого статуса
//   • isCodexMessageEcho — детектится на уровне *между* событиями (см. inferEcho)
//
// Возвращаемые поля:
//   payload      — компактный JSON под TextItem/ThinkingItem/ToolUseItem/ToolResultItem
//   payload_bytes— size до брoтли, для UX "сколько ещё качать"
//   tool_id      — для соединения tu↔tr (используется агрегатором при формировании tool_group)
//
// ВНИМАНИЕ: ToolGroupItem собирается *выше уровнем* (по последовательности display=true items),
// а не здесь. Каждое нормализованное событие производит независимые items.

import type { RenderItem } from "../../../packages/sync-v3/contracts";
import { parseMarkdownBlocks } from "./markdown";

const MAX_TOOL_RESULT_TEXT = 4096;
const MAX_TOOL_INPUT_BYTES = 4096;
// Skip markdown parsing for very long messages — keeps the ingest path fast
// and the payload small. Client falls back to plain-text rendering of `txt`.
const MAX_MARKDOWN_BYTES = 32_768;

export type EventLike = {
  /** id из agent_normalized_events */
  id: number;
  role?: string | null;
  /** event_type from DB */
  eventType?: string | null;
  /** parsed `normalized` jsonb */
  normalized?: any;
  /** raw legacy payload (kept for compatibility with old codex/claude shape) */
  raw?: any;
};

export type RenderRow = {
  source_event_id: number;
  part_index: number;
  kind: RenderItem["k"];
  role: string | null;
  display: boolean;
  payload: object;
  payload_bytes: number;
  tool_id: string | null;
};

/** Главная точка: берёт одно нормализованное событие, возвращает все его render items. */
export function eventToRenderRows(event: EventLike): RenderRow[] {
  const out: RenderRow[] = [];
  const normalized = event.normalized;
  const raw = event.raw;
  let partIndex = 0;

  const displayFlag = normalizedDisplay(normalized);
  // System events / hidden → одна служебная строка с display=false. Хранится для опт-ин показа.
  if (displayFlag === false) {
    out.push({
      source_event_id: event.id,
      part_index: 0,
      kind: "t",
      role: stringOrNull(normalized?.role ?? event.role),
      display: false,
      payload: { k: "t", id: event.id, p: 0, r: "u", txt: "" } satisfies RenderItem & { k: "t" },
      payload_bytes: 0,
      tool_id: null,
    });
    return out;
  }

  // Legacy claude/codex shape: { type, message: { role, content } }
  if (raw && (raw.type === "user" || raw.type === "assistant")) {
    appendContent(out, normalizedTextRole(raw.message?.role ?? raw.type), raw.message?.content, event, () => partIndex++);
    if (out.length) return out;
  }

  if (normalized && typeof normalized === "object" && normalized.display !== false) {
    const role = normalizedTextRole(normalized.role ?? event.role);
    appendContent(out, role, normalized.parts ?? normalized.content ?? normalized.text, event, () => partIndex++);
  }

  return out;
}

function normalizedDisplay(normalized: any): boolean | null {
  if (!normalized || typeof normalized !== "object") return null;
  if (normalized.display === false) return false;
  if (normalized.display === true) return true;
  return null;
}

function appendContent(
  out: RenderRow[],
  role: "user" | "assistant" | null,
  content: unknown,
  event: EventLike,
  nextPart: () => number,
) {
  if (typeof content === "string") {
    appendText(out, role, content, event, nextPart);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) appendContentPart(out, role, part, event, nextPart);
}

function appendContentPart(
  out: RenderRow[],
  role: "user" | "assistant" | null,
  value: any,
  event: EventLike,
  nextPart: () => number,
) {
  if (typeof value === "string") {
    appendText(out, role, value, event, nextPart);
    return;
  }
  if (!value || typeof value !== "object") return;

  const kind = String(value.kind ?? value.type ?? "").toLowerCase();

  if ((kind === "text" || kind === "input_text" || kind === "output_text" || kind === "summary_text") && role && typeof value.text === "string" && value.text.trim()) {
    appendText(out, role, value.text, event, nextPart);
    return;
  }

  if (kind === "thinking" || kind === "reasoning" || kind === "reasoning_text") {
    const thinking = value.thinking ?? value.text ?? value.content;
    if (typeof thinking === "string" && thinking.trim()) {
      const txt = readableText(thinking);
      const p = nextPart();
      const payload = { k: "th" as const, id: event.id, p, txt };
      out.push({
        source_event_id: event.id,
        part_index: p,
        kind: "th",
        role: null,
        display: true,
        payload,
        payload_bytes: jsonBytes(payload),
        tool_id: null,
      });
    }
    return;
  }

  if (kind === "tool_call" || kind === "tool_use" || kind === "function_call" || kind === "server_tool_use") {
    const name = String(value.name ?? value.tool_name ?? kind);
    const tid = String(value.id ?? value.tool_use_id ?? value.call_id ?? `${kind}:${event.id}`);
    const input = truncateInput(value.input ?? value.arguments ?? value.parameters ?? {});
    const p = nextPart();
    const payload = { k: "tu" as const, id: event.id, p, name, in: input, tid };
    out.push({
      source_event_id: event.id,
      part_index: p,
      kind: "tu",
      role: null,
      display: true,
      payload,
      payload_bytes: jsonBytes(payload),
      tool_id: tid,
    });
    return;
  }

  if (kind === "tool_result" || kind === "function_call_output" || kind === "tool_output") {
    const tid = String(value.tool_use_id ?? value.id ?? value.call_id ?? `result:${event.id}`);
    const rawOut = value.content ?? value.output ?? value.result ?? "";
    const { text, truncated } = stringifyToolOutput(rawOut);
    const p = nextPart();
    const payload: any = { k: "tr", id: event.id, p, out: text, tid };
    if (truncated) payload.trunc = true;
    if (value.is_error || value.isError) payload.isErr = true;
    out.push({
      source_event_id: event.id,
      part_index: p,
      kind: "tr",
      role: null,
      display: true,
      payload,
      payload_bytes: jsonBytes(payload),
      tool_id: tid,
    });
    return;
  }

  if (Array.isArray(value.content)) {
    appendContent(out, role, value.content, event, nextPart);
    return;
  }

  if (typeof value.text === "string" && role && value.text.trim()) {
    appendText(out, role, value.text, event, nextPart);
  }
}

function appendText(
  out: RenderRow[],
  role: "user" | "assistant" | null,
  text: string,
  event: EventLike,
  nextPart: () => number,
) {
  const readable = readableText(text);
  if (!role || !readable.trim()) return;
  const p = nextPart();
  const r = role === "assistant" ? ("a" as const) : ("u" as const);
  // Pre-parse markdown into blocks so the client doesn't need react-markdown.
  // For oversize text we skip parsing (the client renders txt as plain text).
  let blocks: RenderItem extends { k: "t"; blocks?: infer B } ? B : undefined;
  if (Buffer.byteLength(readable, "utf8") <= MAX_MARKDOWN_BYTES) {
    const parsed = parseMarkdownBlocks(readable);
    if (parsed.length > 0) blocks = parsed as any;
  }
  const payload: any = { k: "t", id: event.id, p, r, txt: readable };
  if (blocks) payload.blocks = blocks;
  out.push({
    source_event_id: event.id,
    part_index: p,
    kind: "t",
    role,
    display: true,
    payload,
    payload_bytes: jsonBytes(payload),
    tool_id: null,
  });
}

function readableText(text: string) {
  return codexNotificationText(text) ?? text;
}

function codexNotificationText(text: string): string | null {
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
    for (const k of ["completed", "failed", "error", "running", "started"]) {
      if (typeof status[k] === "string") return status[k];
    }
  }
  for (const k of ["message", "text", "summary", "output"]) {
    if (typeof value?.[k] === "string") return value[k];
  }
  return undefined;
}

function normalizedTextRole(value: unknown): "user" | "assistant" | null {
  const role = String(value ?? "").toLowerCase();
  if (role === "assistant") return "assistant";
  if (role === "user" || role === "tool") return "user";
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function truncateInput(input: unknown): unknown {
  try {
    const s = JSON.stringify(input);
    if (s.length <= MAX_TOOL_INPUT_BYTES) return input;
    return { __truncated: true, sample: s.slice(0, MAX_TOOL_INPUT_BYTES), originalBytes: s.length };
  } catch {
    return { __truncated: true, sample: String(input).slice(0, MAX_TOOL_INPUT_BYTES) };
  }
}

function stringifyToolOutput(value: unknown): { text: string; truncated: boolean } {
  let text: string;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) {
    text = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join("\n");
  } else {
    try {
      text = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > MAX_TOOL_RESULT_TEXT) {
    return { text: text.slice(0, MAX_TOOL_RESULT_TEXT), truncated: true };
  }
  return { text, truncated: false };
}

function jsonBytes(value: object): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}
