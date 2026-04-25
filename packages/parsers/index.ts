export type TranscriptProvider = "claude" | "codex" | "gemini" | "unknown";

export type TranscriptRole = "user" | "assistant" | "system" | "tool";

export type TranscriptEventKind =
  | "message"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "session"
  | "turn"
  | "meta"
  | "event"
  | "unknown";

export type TranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id?: string; name: string; input?: unknown }
  | { kind: "tool_result"; id?: string; content: unknown; isError?: boolean }
  | { kind: "event"; name: string; data?: unknown };

export type TranscriptSourceMetadata = {
  provider: TranscriptProvider;
  sourcePath?: string;
  lineNo?: number;
  byteOffset?: number;
  rawType?: string;
  rawKind?: string;
};

export type TranscriptEvent = {
  kind: TranscriptEventKind;
  role: TranscriptRole;
  parts: TranscriptPart[];
  timestamp?: string;
  display: boolean;
  source: TranscriptSourceMetadata;
  raw: unknown;
};

export type NormalizeOptions = {
  provider?: TranscriptProvider;
  sourcePath?: string;
  lineNo?: number;
  byteOffset?: number;
};

export type JsonlDiagnostic = {
  lineNo: number;
  byteOffset: number;
  message: string;
  rawLine: string;
};

export type NormalizeJsonlResult = {
  events: TranscriptEvent[];
  diagnostics: JsonlDiagnostic[];
};

type JsonObject = Record<string, unknown>;

const textEncoder = new TextEncoder();

export function normalizeTranscriptRecord(raw: unknown, options: NormalizeOptions = {}): TranscriptEvent {
  const provider = options.provider ?? inferProvider(raw, options.sourcePath);
  if (provider === "claude") return normalizeClaudeRecord(raw, options);
  if (provider === "codex") return normalizeCodexRecord(raw, options);
  if (provider === "gemini") return normalizeGeminiRecord(raw, options);
  return normalizeUnknownRecord(raw, options);
}

export function normalizeJsonlTranscript(jsonl: string, options: Omit<NormalizeOptions, "lineNo" | "byteOffset"> = {}): NormalizeJsonlResult {
  const events: TranscriptEvent[] = [];
  const diagnostics: JsonlDiagnostic[] = [];

  let lineNo = 1;
  let charStart = 0;
  let byteOffset = 0;

  while (charStart <= jsonl.length) {
    const newline = jsonl.indexOf("\n", charStart);
    const charEnd = newline === -1 ? jsonl.length : newline;
    const rawLineWithCarriage = jsonl.slice(charStart, charEnd);
    const rawLine = rawLineWithCarriage.endsWith("\r") ? rawLineWithCarriage.slice(0, -1) : rawLineWithCarriage;

    if (rawLine.trim()) {
      try {
        events.push(
          normalizeTranscriptRecord(JSON.parse(rawLine), {
            ...options,
            lineNo,
            byteOffset,
          }),
        );
      } catch (error) {
        diagnostics.push({
          lineNo,
          byteOffset,
          message: error instanceof Error ? error.message : "Invalid JSONL record",
          rawLine,
        });
        events.push(
          nonDisplayEvent(rawLine, {
            ...options,
            provider: options.provider ?? "unknown",
            lineNo,
            byteOffset,
            rawType: "invalid_json",
            rawKind: "invalid_json",
          }),
        );
      }
    }

    if (newline === -1) break;
    byteOffset += utf8ByteLength(jsonl.slice(charStart, newline + 1));
    charStart = newline + 1;
    lineNo++;
  }

  return { events, diagnostics };
}

export function normalizeClaudeRecord(raw: unknown, options: NormalizeOptions = {}): TranscriptEvent {
  const object = asObject(raw);
  const message = asObject(object?.message);
  const rawType = stringValue(object?.type);
  const rawKind = stringValue(object?.kind) ?? stringValue(message?.type) ?? rawType;
  const role = normalizeRole(stringValue(message?.role) ?? rawType);
  const parts = normalizeContentParts(message?.content ?? object?.content, "claude");
  const kind = kindForRoleAndParts(role, parts, rawType);

  return {
    kind,
    role,
    parts,
    timestamp: extractTimestamp(object, message),
    display: (role === "user" || role === "assistant" || role === "tool") && parts.length > 0,
    source: sourceMetadata(raw, { ...options, provider: "claude", rawType, rawKind }),
    raw,
  };
}

export function normalizeCodexRecord(raw: unknown, options: NormalizeOptions = {}): TranscriptEvent {
  const object = asObject(raw);
  if (!object) return normalizeUnknownRecord(raw, { ...options, provider: "codex" });
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

export function normalizeGeminiRecord(raw: unknown, options: NormalizeOptions = {}): TranscriptEvent {
  const object = asObject(raw);
  const rawType = stringValue(object?.type);
  const rawKind = stringValue(object?.kind) ?? rawType ?? stringValue(object?.role) ?? "gemini";
  const role = normalizeRole(stringValue(object?.role) === "model" ? "assistant" : stringValue(object?.role));
  const parts = normalizeContentParts(object?.parts ?? object?.content ?? object?.text, "gemini");

  return {
    kind: kindForRoleAndParts(role, parts, rawType),
    role,
    parts,
    timestamp: extractTimestamp(object),
    display: parts.length > 0,
    source: sourceMetadata(raw, { ...options, provider: "gemini", rawType, rawKind }),
    raw,
  };
}

export function normalizeUnknownRecord(raw: unknown, options: NormalizeOptions = {}): TranscriptEvent {
  const object = asObject(raw);
  const rawType = stringValue(object?.type);
  const rawKind = stringValue(object?.kind) ?? stringValue(object?.event) ?? rawType ?? "unknown";
  return {
    kind: "event",
    role: "system",
    parts: [{ kind: "event", name: rawKind, data: object ?? raw }],
    timestamp: object ? extractTimestamp(object) : undefined,
    display: false,
    source: sourceMetadata(raw, { ...options, provider: options.provider ?? "unknown", rawType, rawKind }),
    raw,
  };
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
      display: parts.length > 0,
      source: context.source,
      raw,
    };
  }

  if (itemType === "function_call" || itemType === "tool_call") {
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

  if (itemType === "function_call_output" || itemType === "tool_result") {
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
  if (type === "function_call" || type === "tool_call") return [codexToolCallPart(object, type)];
  if (type === "function_call_output" || type === "tool_result") return [codexToolResultPart(object)];
  if (type === "reasoning") {
    return normalizeContentParts(object.summary ?? object.content ?? object.text, "codex").map((part) =>
      part.kind === "text" ? ({ kind: "thinking", text: part.text } as const) : part,
    );
  }

  return normalizeContentParts(object.content ?? object.text ?? object, "codex");
}

function normalizeContentParts(value: unknown, provider: TranscriptProvider): TranscriptPart[] {
  if (typeof value === "string") return value.trim() ? [{ kind: "text", text: value }] : [];
  if (value == null) return [];

  if (Array.isArray(value)) {
    return value.flatMap((part) => normalizeContentPart(part, provider));
  }

  const object = asObject(value);
  if (!object) return [];
  if (Array.isArray(object.parts)) return normalizeContentParts(object.parts, provider);
  if (Array.isArray(object.content)) return normalizeContentParts(object.content, provider);
  if (typeof object.text === "string") return object.text.trim() ? [{ kind: "text", text: object.text }] : [];
  if (typeof object.message === "string") return object.message.trim() ? [{ kind: "text", text: object.message }] : [];

  return [];
}

function normalizeContentPart(part: unknown, provider: TranscriptProvider): TranscriptPart[] {
  if (typeof part === "string") return part.trim() ? [{ kind: "text", text: part }] : [];

  const object = asObject(part);
  if (!object) return [];

  const type = stringValue(object.type)?.toLowerCase();
  if (!type && typeof object.text === "string") return object.text.trim() ? [{ kind: "text", text: object.text }] : [];

  switch (type) {
    case "text":
    case "input_text":
    case "output_text":
    case "summary_text":
      return textPart(object.text);
    case "thinking":
    case "reasoning":
    case "reasoning_text":
      return thinkingPart(object.thinking ?? object.text ?? object.content);
    case "tool_use":
    case "server_tool_use":
    case "function_call":
    case "tool_call":
      return [
        {
          kind: "tool_call",
          id: stringValue(object.id) ?? stringValue(object.tool_use_id) ?? stringValue(object.call_id),
          name: stringValue(object.name) ?? stringValue(object.tool_name) ?? type,
          input: parseArguments(object.input ?? object.arguments ?? object.parameters),
        },
      ];
    case "tool_result":
    case "function_call_output":
    case "tool_output":
      return [
        {
          kind: "tool_result",
          id: stringValue(object.tool_use_id) ?? stringValue(object.id) ?? stringValue(object.call_id),
          content: object.content ?? object.output ?? object.result ?? "",
          isError: booleanValue(object.is_error) ?? booleanValue(object.isError) ?? booleanValue(object.error),
        },
      ];
    case "image":
    case "image_url":
    case "input_image":
      return [{ kind: "event", name: type, data: object }];
    default:
      if (provider === "gemini" && typeof object.text === "string") return textPart(object.text);
      if (typeof object.text === "string") return textPart(object.text);
      return [{ kind: "event", name: type ?? "part", data: object }];
  }
}

function textPart(value: unknown): TranscriptPart[] {
  return typeof value === "string" && value.trim() ? [{ kind: "text", text: value }] : [];
}

function thinkingPart(value: unknown): TranscriptPart[] {
  return typeof value === "string" && value.trim() ? [{ kind: "thinking", text: value }] : [];
}

function codexToolCallPart(object: JsonObject, rawKind: string): TranscriptPart {
  const command = object.command ?? object.cmd;
  const input =
    command !== undefined
      ? { command }
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
    content: object.output ?? object.content ?? object.result ?? object.message ?? "",
    isError: booleanValue(object.is_error) ?? booleanValue(object.isError) ?? booleanValue(object.error) ?? stringValue(object.status) === "failed",
  };
}

function kindForRoleAndParts(role: TranscriptRole, parts: TranscriptPart[], rawType?: string): TranscriptEventKind {
  const lowerType = rawType?.toLowerCase() ?? "";
  if (lowerType.includes("session")) return "session";
  if (lowerType.includes("turn")) return "turn";
  if (lowerType.includes("meta")) return "meta";
  if (parts.length && parts.every((part) => part.kind === "thinking")) return "thinking";
  if (parts.length && parts.every((part) => part.kind === "tool_call")) return "tool_call";
  if (parts.length && parts.every((part) => part.kind === "tool_result")) return "tool_result";
  return role === "system" ? "event" : "message";
}

function sourceMetadata(
  raw: unknown,
  options: NormalizeOptions & { rawType?: string; rawKind?: string },
): TranscriptSourceMetadata {
  const object = asObject(raw);
  return {
    provider: options.provider ?? "unknown",
    sourcePath: options.sourcePath,
    lineNo: options.lineNo,
    byteOffset: options.byteOffset,
    rawType: options.rawType ?? stringValue(object?.type),
    rawKind: options.rawKind ?? stringValue(object?.kind) ?? stringValue(object?.event) ?? stringValue(object?.type),
  };
}

function nonDisplayEvent(
  raw: unknown,
  options: NormalizeOptions & { rawType?: string; rawKind?: string },
): TranscriptEvent {
  return {
    kind: "event",
    role: "system",
    parts: [{ kind: "event", name: options.rawKind ?? "event", data: raw }],
    display: false,
    source: sourceMetadata(raw, options),
    raw,
  };
}

function inferProvider(raw: unknown, sourcePath?: string): TranscriptProvider {
  const lowerPath = sourcePath?.toLowerCase() ?? "";
  if (lowerPath.includes("claude")) return "claude";
  if (lowerPath.includes("codex")) return "codex";
  if (lowerPath.includes("gemini")) return "gemini";

  const object = asObject(raw);
  const type = stringValue(object?.type)?.toLowerCase() ?? "";
  const message = asObject(object?.message);
  const item = asObject(object?.item);
  if ((type === "user" || type === "assistant") && message && "content" in message) return "claude";
  if (item || type.includes("codex") || type.includes("response.") || isCodexUserMessage(type, type) || isCodexAssistantMessage(type, type)) {
    return "codex";
  }
  return "unknown";
}

function normalizeRole(value?: string): TranscriptRole {
  const lower = value?.toLowerCase();
  if (lower === "user" || lower === "human") return "user";
  if (lower === "assistant" || lower === "model" || lower === "agent") return "assistant";
  if (lower === "tool" || lower === "function") return "tool";
  return "system";
}

function extractTimestamp(...objects: Array<JsonObject | undefined>): string | undefined {
  for (const object of objects) {
    if (!object) continue;
    for (const key of ["timestamp", "created_at", "createdAt", "time", "date"]) {
      const value = object[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return undefined;
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

function isCodexUserMessage(type: string, kind: string) {
  return type === "user" || type.includes("user_message") || kind.includes("user_message") || type === "input_text";
}

function isCodexAssistantMessage(type: string, kind: string) {
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
    type.includes("tool_output") ||
    kind.includes("tool_output") ||
    type.includes("exec_command_output") ||
    kind.includes("exec_command_output") ||
    type.includes("exec_command_end") ||
    kind.includes("exec_command_end")
  );
}

function compactEventData(object?: JsonObject): unknown {
  if (!object) return undefined;
  const data = { ...object };
  delete data.type;
  delete data.kind;
  delete data.event;
  return Object.keys(data).length ? data : undefined;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function utf8ByteLength(value: string) {
  return textEncoder.encode(value).byteLength;
}
