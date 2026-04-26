import {
  asObject,
  booleanValue,
  compactEventData,
  extractTimestamp,
  kindForRoleAndParts,
  normalizeRole,
  parseArguments,
  sourceMetadata,
  stringValue,
} from "./common";
import { normalizeContentParts } from "./content";
import type { JsonObject, NormalizeOptions, TranscriptEvent, TranscriptPart, TranscriptSourceMetadata } from "./types";

export function normalizeCodexRecord(raw: unknown, options: NormalizeOptions = {}): TranscriptEvent {
  const object = asObject(raw);
  if (!object) return normalizeCodexUnknown(raw, options);
  const item = asObject(object?.item);
  const message = asObject(object?.message);
  const rawType = stringValue(object?.type) ?? stringValue(item?.type) ?? stringValue(message?.type);
  const rawKind =
    stringValue(object?.kind) ??
    stringValue(object?.event) ??
    stringValue(item?.type) ??
    stringValue(message?.type) ??
    rawType ??
    "unknown";

  const source = sourceMetadata(raw, { ...options, provider: "codex", rawType, rawKind });
  const timestamp = extractTimestamp(object, item, message);
  const lowerType = (rawType ?? "").toLowerCase();
  const lowerKind = rawKind.toLowerCase();
  const payload = asObject(object?.payload);

  if (payload) {
    const payloadKind = stringValue(payload.type) ?? rawKind;
    const payloadEvent = normalizeCodexPayloadEnvelope(raw, payload, {
      source: sourceMetadata(raw, { ...options, provider: "codex", rawType, rawKind: payloadKind }),
      timestamp,
      rawKind: payloadKind,
      envelopeType: lowerType,
    });
    if (payloadEvent) return payloadEvent;
  }

  if (isSessionLike(lowerType, lowerKind)) {
    return {
      kind: lowerType.includes("turn") || lowerKind.includes("turn") ? "turn" : lowerType.includes("meta") || lowerKind.includes("meta") ? "meta" : "session",
      role: "system",
      parts: [{ kind: "event", name: rawKind, data: compactEventData(object) }],
      timestamp,
      display: false,
      source,
      raw,
    };
  }

  if (item) {
    return normalizeCodexItem(raw, item, { source, timestamp, rawKind });
  }

  if (Array.isArray(object?.output)) {
    const parts = object.output.flatMap((entry) => normalizeCodexOutputItem(entry));
    return {
      kind: kindForRoleAndParts("assistant", parts, rawType),
      role: "assistant",
      parts,
      timestamp,
      display: parts.length > 0,
      source,
      raw,
    };
  }

  if (isCodexToolCall(lowerType, lowerKind)) {
    const part = codexToolCallPart(object, rawKind);
    return {
      kind: "tool_call",
      role: "tool",
      parts: [part],
      timestamp,
      display: true,
      source,
      raw,
    };
  }

  if (isCodexToolResult(lowerType, lowerKind)) {
    const part = codexToolResultPart(object);
    return {
      kind: "tool_result",
      role: "tool",
      parts: [part],
      timestamp,
      display: true,
      source,
      raw,
    };
  }

  if (isCodexUserMessage(lowerType, lowerKind)) {
    const parts = normalizeContentParts(object.message ?? object.content ?? object.text ?? object.input, "codex");
    return {
      kind: "message",
      role: "user",
      parts,
      timestamp,
      display: parts.length > 0,
      source,
      raw,
    };
  }

  if (isCodexAssistantMessage(lowerType, lowerKind)) {
    const rawParts = normalizeContentParts(object.message ?? object.content ?? object.text ?? object.output ?? object.summary, "codex");
    const parts =
      lowerType.includes("reasoning") || lowerKind.includes("reasoning")
        ? rawParts.map((part) => (part.kind === "text" ? ({ kind: "thinking", text: part.text } as const) : part))
        : rawParts;
    return {
      kind: parts.some((part) => part.kind === "thinking") && parts.every((part) => part.kind === "thinking") ? "thinking" : "message",
      role: "assistant",
      parts,
      timestamp,
      display: parts.length > 0,
      source,
      raw,
    };
  }

  const role = normalizeRole(stringValue(object?.role) ?? stringValue(message?.role));
  if (role !== "system") {
    const parts = normalizeContentParts(message?.content ?? object?.content ?? object?.text ?? object?.message, "codex");
    return {
      kind: kindForRoleAndParts(role, parts, rawType),
      role,
      parts,
      timestamp,
      display: parts.length > 0,
      source,
      raw,
    };
  }

  return {
    kind: "event",
    role: "system",
    parts: [{ kind: "event", name: rawKind, data: compactEventData(object) }],
    timestamp,
    display: false,
    source,
    raw,
  };
}

function normalizeCodexUnknown(raw: unknown, options: NormalizeOptions): TranscriptEvent {
  const source = sourceMetadata(raw, { ...options, provider: "codex", rawKind: "unknown" });
  return {
    kind: "event",
    role: "system",
    parts: [{ kind: "event", name: "unknown", data: raw }],
    display: false,
    source,
    raw,
  };
}

function normalizeCodexPayloadEnvelope(
  raw: unknown,
  payload: JsonObject,
  context: { source: TranscriptSourceMetadata; timestamp?: string; rawKind: string; envelopeType: string },
): TranscriptEvent | null {
  const payloadType = stringValue(payload.type)?.toLowerCase() ?? context.rawKind.toLowerCase();

  if (context.envelopeType === "response_item") return normalizeCodexItem(raw, payload, context);

  if (context.envelopeType === "event_msg") {
    if (payloadType === "user_message" || payloadType === "agent_message") {
      const role = payloadType === "agent_message" ? "assistant" : "user";
      const parts = normalizeContentParts(payload.message ?? payload.content ?? payload.text, "codex");
      return {
        kind: kindForRoleAndParts(role, parts, payloadType),
        role,
        parts,
        timestamp: context.timestamp,
        display: parts.length > 0,
        source: context.source,
        raw,
      };
    }

    if (payloadType === "exec_command_begin") {
      return {
        kind: "tool_call",
        role: "tool",
        parts: [codexToolCallPart(payload, context.rawKind)],
        timestamp: context.timestamp,
        display: true,
        source: context.source,
        raw,
      };
    }

    if (payloadType === "exec_command_end") {
      return {
        kind: "tool_result",
        role: "tool",
        parts: [codexToolResultPart(payload)],
        timestamp: context.timestamp,
        display: true,
        source: context.source,
        raw,
      };
    }
  }

  if (context.envelopeType === "session_meta" || context.envelopeType === "turn_context" || context.envelopeType === "compacted") {
    return {
      kind: context.envelopeType === "turn_context" ? "turn" : context.envelopeType.includes("meta") ? "meta" : "session",
      role: "system",
      parts: [{ kind: "event", name: context.rawKind, data: payload }],
      timestamp: context.timestamp,
      display: false,
      source: context.source,
      raw,
    };
  }

  return null;
}

function normalizeCodexItem(
  raw: unknown,
  item: JsonObject,
  context: { source: TranscriptSourceMetadata; timestamp?: string; rawKind: string },
): TranscriptEvent {
  const itemType = stringValue(item.type)?.toLowerCase() ?? "";

  if (itemType === "message") {
    const role = normalizeRole(stringValue(item.role));
    const parts = normalizeContentParts(item.content, "codex");
    return {
      kind: kindForRoleAndParts(role, parts, itemType),
      role,
      parts,
      timestamp: context.timestamp,
      display: (role === "user" || role === "assistant") && parts.length > 0,
      source: context.source,
      raw,
    };
  }

  if (itemType === "function_call" || itemType === "tool_call" || itemType === "custom_tool_call" || itemType === "tool_search_call") {
    return {
      kind: "tool_call",
      role: "tool",
      parts: [codexToolCallPart(item, context.rawKind)],
      timestamp: context.timestamp,
      display: true,
      source: context.source,
      raw,
    };
  }

  if (
    itemType === "function_call_output" ||
    itemType === "tool_result" ||
    itemType === "custom_tool_call_output" ||
    itemType === "tool_search_output"
  ) {
    return {
      kind: "tool_result",
      role: "tool",
      parts: [codexToolResultPart(item)],
      timestamp: context.timestamp,
      display: true,
      source: context.source,
      raw,
    };
  }

  if (itemType === "reasoning") {
    const parts = normalizeContentParts(item.summary ?? item.content ?? item.text, "codex");
    return {
      kind: "thinking",
      role: "assistant",
      parts: parts.length ? parts.map((part) => (part.kind === "text" ? ({ kind: "thinking", text: part.text } as const) : part)) : [],
      timestamp: context.timestamp,
      display: parts.length > 0,
      source: context.source,
      raw,
    };
  }

  return {
    kind: "event",
    role: "system",
    parts: [{ kind: "event", name: context.rawKind, data: item }],
    timestamp: context.timestamp,
    display: false,
    source: context.source,
    raw,
  };
}

function normalizeCodexOutputItem(entry: unknown): TranscriptPart[] {
  const object = asObject(entry);
  if (!object) return normalizeContentParts(entry, "codex");

  const type = stringValue(object.type)?.toLowerCase();
  if (type === "message") return normalizeContentParts(object.content, "codex");
  if (type === "function_call" || type === "tool_call" || type === "custom_tool_call" || type === "tool_search_call") {
    return [codexToolCallPart(object, type)];
  }
  if (type === "function_call_output" || type === "tool_result" || type === "custom_tool_call_output" || type === "tool_search_output") {
    return [codexToolResultPart(object)];
  }
  if (type === "reasoning") {
    return normalizeContentParts(object.summary ?? object.content ?? object.text, "codex").map((part) =>
      part.kind === "text" ? ({ kind: "thinking", text: part.text } as const) : part,
    );
  }

  return normalizeContentParts(object.content ?? object.text ?? object, "codex");
}

function codexToolCallPart(object: JsonObject, rawKind: string): TranscriptPart {
  const command = object.command ?? object.cmd;
  const input =
    command !== undefined
      ? { command, ...(typeof object.cwd === "string" ? { cwd: object.cwd } : {}) }
      : parseArguments(object.input ?? object.arguments ?? object.parameters ?? object.tool_input ?? object);
  return {
    kind: "tool_call",
    id: stringValue(object.call_id) ?? stringValue(object.tool_call_id) ?? stringValue(object.id),
    name: stringValue(object.name) ?? stringValue(object.tool_name) ?? (String(rawKind).includes("exec") ? "exec_command" : "tool"),
    input,
  };
}

function codexToolResultPart(object: JsonObject): TranscriptPart {
  return {
    kind: "tool_result",
    id: stringValue(object.call_id) ?? stringValue(object.tool_call_id) ?? stringValue(object.id),
    content: object.output ?? object.formatted_output ?? object.aggregated_output ?? object.stdout ?? object.content ?? object.result ?? object.message ?? "",
    isError:
      booleanValue(object.is_error) ??
      booleanValue(object.isError) ??
      booleanValue(object.error) ??
      (stringValue(object.status) === "failed" ? true : undefined) ??
      (typeof object.exit_code === "number" ? object.exit_code !== 0 : undefined),
  };
}

function isSessionLike(type: string, kind: string) {
  return (
    type.includes("session") ||
    kind.includes("session") ||
    type.includes("turn_context") ||
    kind.includes("turn_context") ||
    type === "turn" ||
    kind === "turn" ||
    type.includes("meta") ||
    kind.includes("meta") ||
    type === "context" ||
    kind === "context"
  );
}

export function isCodexUserMessage(type: string, kind: string) {
  return type === "user" || type.includes("user_message") || kind.includes("user_message") || type === "input_text";
}

export function isCodexAssistantMessage(type: string, kind: string) {
  return (
    type === "assistant" ||
    type.includes("assistant_message") ||
    kind.includes("assistant_message") ||
    type.includes("agent_message") ||
    kind.includes("agent_message") ||
    type.includes("model_output") ||
    kind.includes("model_output") ||
    type.includes("output_text") ||
    type.includes("reasoning") ||
    kind.includes("reasoning")
  );
}

function isCodexToolCall(type: string, kind: string) {
  return (
    type.includes("tool_call") ||
    kind.includes("tool_call") ||
    type.includes("function_call") ||
    kind.includes("function_call") ||
    type.includes("tool_search_call") ||
    kind.includes("tool_search_call") ||
    type.includes("exec_command_begin") ||
    kind.includes("exec_command_begin")
  );
}

function isCodexToolResult(type: string, kind: string) {
  return (
    type.includes("tool_result") ||
    kind.includes("tool_result") ||
    type.includes("function_call_output") ||
    kind.includes("function_call_output") ||
    type.includes("tool_search_output") ||
    kind.includes("tool_search_output") ||
    type.includes("tool_output") ||
    kind.includes("tool_output") ||
    type.includes("exec_command_output") ||
    kind.includes("exec_command_output") ||
    type.includes("exec_command_end") ||
    kind.includes("exec_command_end")
  );
}
