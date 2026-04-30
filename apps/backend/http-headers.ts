import { toWellFormedText } from "./postgres-sanitize";

export function inlineContentDisposition(filename?: string | null) {
  return contentDisposition("inline", filename);
}

export function attachmentContentDisposition(filename?: string | null) {
  return contentDisposition("attachment", filename);
}

export function safeContentType(value?: string | null, fallback = "application/octet-stream") {
  const text = value?.trim();
  if (!text || !isAsciiHeaderValue(text)) return fallback;
  try {
    new Headers({ "content-type": text });
    return text;
  } catch {
    return fallback;
  }
}

export function asciiFilenameFallback(filename: string) {
  const fallback = toWellFormedText(filename)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\\"\r\n;]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return truncateHeaderFilename(fallback || "download");
}

function truncateHeaderFilename(filename: string) {
  if (filename.length <= 180) return filename;
  return filename.slice(0, 180).trim() || "download";
}

function encodeRfc5987Value(value: string) {
  return encodeURIComponent(toWellFormedText(value)).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function contentDisposition(disposition: "inline" | "attachment", filename?: string | null) {
  if (!filename) return undefined;
  return `${disposition}; filename="${asciiFilenameFallback(filename)}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function isAsciiHeaderValue(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}
