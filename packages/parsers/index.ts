import {
  asObject,
  extractTimestamp,
  kindForRoleAndParts,
  nonDisplayEvent,
  normalizeRole,
  sourceMetadata,
  stringValue,
  utf8ByteLength,
} from "./common";
import { normalizeContentParts } from "./content";
import { isCodexAssistantMessage, isCodexUserMessage, normalizeCodexRecord } from "./codex";
import type {
  JsonlDiagnostic,
  NormalizeJsonlResult,
  NormalizeOptions,
  TranscriptEvent,
  TranscriptEventKind,
  TranscriptPart,
  TranscriptProvider,
  TranscriptRole,
  TranscriptSourceMetadata,
} from "./types";

export type {
  JsonlDiagnostic,
  NormalizeJsonlResult,
  NormalizeOptions,
  TranscriptEvent,
  TranscriptEventKind,
  TranscriptPart,
  TranscriptProvider,
  TranscriptRole,
  TranscriptSourceMetadata,
} from "./types";
export { normalizeCodexRecord } from "./codex";

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
