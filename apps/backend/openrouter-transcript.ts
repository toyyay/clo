import type { AudioTranscriptPayload } from "../../packages/shared/types";

export function parseJsonObject(raw: string): any | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function parseJsonObjectLoose(raw: string): any | null {
  const trimmed = stripJsonCodeFence(raw);
  const parsed = parseJsonObject(trimmed);
  if (parsed) return parsed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return parseJsonObject(trimmed.slice(start, end + 1));
  return null;
}

export function extractOpenRouterMessageContent(responseJson: any) {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function normalizeStoredTranscript(value: unknown): AudioTranscriptPayload {
  const raw = typeof value === "string" ? parseJsonObjectLoose(value) : value;
  const object = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  return {
    detectedLanguage: typeof object.detectedLanguage === "string" ? object.detectedLanguage : null,
    detectedLanguageName: typeof object.detectedLanguageName === "string" ? object.detectedLanguageName : null,
    ru: normalizeTranscriptLevel(object.ru),
    en: normalizeTranscriptLevel(object.en),
  };
}

export function validateStoredTranscript(transcript: AudioTranscriptPayload) {
  const required = [
    ["ru.literal", transcript.ru.literal],
    ["ru.clean", transcript.ru.clean],
    ["ru.summary", transcript.ru.summary],
    ["ru.brief", transcript.ru.brief],
    ["en.literal", transcript.en.literal],
    ["en.clean", transcript.en.clean],
    ["en.summary", transcript.en.summary],
    ["en.brief", transcript.en.brief],
  ] as const;
  const missing = required.filter(([, value]) => !value.trim());

  if (transcript.ru.literal.trim().length < 3 && transcript.en.literal.trim().length < 3) {
    throw new Error("OpenRouter returned an empty transcript");
  }
  if (missing.length) {
    throw new Error(`OpenRouter returned a malformed transcript: missing ${missing.map(([key]) => key).join(", ")}`);
  }
}

function stripJsonCodeFence(raw: string) {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function normalizeTranscriptLevel(value: unknown) {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    literal: typeof object.literal === "string" ? object.literal : "",
    clean: typeof object.clean === "string" ? object.clean : "",
    summary: typeof object.summary === "string" ? object.summary : "",
    brief: typeof object.brief === "string" ? object.brief : "",
  };
}
