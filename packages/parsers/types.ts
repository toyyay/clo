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

export type JsonObject = Record<string, unknown>;
