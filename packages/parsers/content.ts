import { asObject, booleanValue, parseArguments, stringValue } from "./common";
import type { TranscriptPart, TranscriptProvider } from "./types";

export function normalizeContentParts(value: unknown, provider: TranscriptProvider): TranscriptPart[] {
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
