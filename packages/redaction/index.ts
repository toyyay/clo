export type RedactionCategory =
  | "api_token"
  | "aws_key_id"
  | "aws_secret"
  | "bearer_token"
  | "certificate"
  | "jwt"
  | "private_key"
  | "sensitive_file"
  | "structured_secret";

export type RedactionCounts = {
  total: number;
  categories: Partial<Record<RedactionCategory, number>>;
};

export type RedactionResult<T> = {
  value: T;
  redactions: RedactionCounts;
};

type MutableCounts = {
  total: number;
  categories: Record<string, number>;
};

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | { [key: string]: JsonLike };

export type RedactedJsonValue<T> = T extends string
  ? string
  : T extends (infer Item)[]
    ? RedactedJsonValue<Item>[]
    : T extends object
      ? { [Key in keyof T]: string | RedactedJsonValue<T[Key]> }
      : T;

const REDACTED = "[REDACTED]";
const CATEGORY_ORDER: RedactionCategory[] = [
  "private_key",
  "certificate",
  "structured_secret",
  "bearer_token",
  "jwt",
  "api_token",
  "aws_key_id",
  "aws_secret",
  "sensitive_file",
];

const KNOWN_SENSITIVE_BASENAMES = new Set([
  "auth.json",
  "oauth_creds.json",
  "google_accounts.json",
  "cookies",
  "local storage",
  "local-storage",
  "local_storage",
  "localstorage",
]);

export function redactText(text: string): RedactionResult<string> {
  const counts = createCounts();
  let value = text;

  value = replaceMatches(
    value,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "private_key",
    counts,
  );
  value = replaceMatches(
    value,
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    "certificate",
    counts,
  );

  value = redactStructuredTextValues(value, counts);
  value = replaceMatches(value, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g, "bearer_token", counts);
  value = replaceJwtLike(value, counts);
  value = replaceMatches(value, /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "api_token", counts);
  value = replaceMatches(value, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "api_token", counts);
  value = replaceMatches(value, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "api_token", counts);
  value = replaceMatches(value, /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "api_token", counts);
  value = replaceMatches(value, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws_key_id", counts);
  value = replaceSensitiveBasenamePaths(value, counts);

  return { value, redactions: freezeCounts(counts) };
}

export function redactJsonValue<T extends JsonLike>(value: T): RedactionResult<RedactedJsonValue<T>> {
  const counts = createCounts();
  const redacted = redactJsonNode(value, counts, undefined) as RedactedJsonValue<T>;

  return { value: redacted, redactions: freezeCounts(counts) };
}

export function summarizeRedactions(input: RedactionCounts | RedactionResult<unknown>): RedactionCounts {
  const counts = "redactions" in input ? input.redactions : input;
  return {
    total: counts.total,
    categories: { ...counts.categories },
  };
}

function redactJsonNode(value: JsonLike, counts: MutableCounts, parentKey: string | undefined): JsonLike {
  if (parentKey && isSensitiveKey(parentKey)) {
    addCount(counts, structuredCategoryForKey(parentKey));
    return marker(structuredCategoryForKey(parentKey));
  }

  if (parentKey && isSensitiveBasename(parentKey)) {
    addCount(counts, "sensitive_file");
    return marker("sensitive_file");
  }

  if (typeof value === "string") {
    const result = redactText(value);
    mergeCounts(counts, result.redactions);
    return result.value;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonNode(item, counts, undefined));
  }

  const redacted: { [key: string]: JsonLike } = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = redactJsonNode(child, counts, key);
  }

  return redacted;
}

function redactStructuredTextValues(text: string, counts: MutableCounts): string {
  let value = text.replace(
    /(^|[\s;])((?:export\s+)?([A-Za-z_авекмнорстухАВЕКМНОРСТУХ][A-Za-z0-9_авекмнорстухАВЕКМНОРСТУХ-]*)\s*=\s*)(?:"([^"\n]{1,4096})"|'([^'\n]{1,4096})'|([^\s;#]{1,4096}))/gm,
    (match, lead: string, prefix: string, key: string, doubleQuoted?: string, singleQuoted?: string, _bare?: string) => {
      if (!isSensitiveKey(key)) {
        return match;
      }

      const category = structuredCategoryForKey(key);
      addCount(counts, category);

      if (doubleQuoted !== undefined) {
        return `${lead}${prefix}"${marker(category)}"`;
      }
      if (singleQuoted !== undefined) {
        return `${lead}${prefix}'${marker(category)}'`;
      }
      return `${lead}${prefix}${marker(category)}`;
    },
  );

  value = value.replace(
    /(["'])([^"'\n]{1,128})\1(\s*:\s*)(?:"([^"\n]{1,4096})"|'([^'\n]{1,4096})')/g,
    (match, quote: string, key: string, separator: string, doubleQuoted?: string, _singleQuoted?: string) => {
      if (!isSensitiveKey(key)) {
        return match;
      }

      const category = structuredCategoryForKey(key);
      addCount(counts, category);
      const valueQuote = doubleQuoted !== undefined ? "\"" : "'";
      return `${quote}${key}${quote}${separator}${valueQuote}${marker(category)}${valueQuote}`;
    },
  );

  value = value.replace(
    /^([ \t-]*)([A-Za-z_авекмнорстухАВЕКМНОРСТУХ][A-Za-z0-9_авекмнорстухАВЕКМНОРСТУХ -]{0,127})(\s*:\s*)(?:"([^"\n]{1,4096})"|'([^'\n]{1,4096})'|([^\s#][^\n#]{0,4095}))/gm,
    (match, indent: string, key: string, separator: string, doubleQuoted?: string, singleQuoted?: string, _bare?: string) => {
      if (!isSensitiveKey(key)) {
        return match;
      }

      const category = structuredCategoryForKey(key);
      addCount(counts, category);
      if (doubleQuoted !== undefined) {
        return `${indent}${key}${separator}"${marker(category)}"`;
      }
      if (singleQuoted !== undefined) {
        return `${indent}${key}${separator}'${marker(category)}'`;
      }
      return `${indent}${key}${separator}${marker(category)}`;
    },
  );

  value = value.replace(
    /(^|[\s{,])((?:aws_secret_access_key|awsSecretAccessKey)\s*[:=]\s*)(["']?)([A-Za-z0-9/+=]{40})(\3)/gi,
    (_match, lead: string, prefix: string, quote: string) => {
      addCount(counts, "aws_secret");
      return `${lead}${prefix}${quote}${marker("aws_secret")}${quote}`;
    },
  );

  return value;
}

function replaceMatches(text: string, pattern: RegExp, category: RedactionCategory, counts: MutableCounts): string {
  return text.replace(pattern, () => {
    addCount(counts, category);
    return marker(category);
  });
}

function replaceJwtLike(text: string, counts: MutableCounts): string {
  return text.replace(
    /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g,
    (match) => {
      if (!looksLikeJwt(match)) {
        return match;
      }

      addCount(counts, "jwt");
      return marker("jwt");
    },
  );
}

function replaceSensitiveBasenamePaths(text: string, counts: MutableCounts): string {
  return text.replace(
    /(^|[\s"'(=:[,{])((?:[A-Za-z]:)?(?:(?:~|\.{1,2}|[A-Za-z0-9_.-]+)[\\/])+)(auth\.json|oauth_creds\.json|google_accounts\.json|cookies|local[ _-]?storage|localstorage)(?=$|[\s"',;)\]}])/gi,
    (_match, lead: string, prefix: string, _basename: string) => {
      addCount(counts, "sensitive_file");
      return `${lead}${prefix}${marker("sensitive_file")}`;
    },
  );
}

function looksLikeJwt(value: string): boolean {
  const [header, payload] = value.split(".");
  return jsonBase64UrlStartsObject(header) && jsonBase64UrlStartsObject(payload);
}

function jsonBase64UrlStartsObject(value: string): boolean {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = atob(padded);
    return decoded.trimStart().startsWith("{");
  } catch {
    return false;
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeIdentifier(key);
  if (!normalized) {
    return false;
  }

  if (
    normalized === "token" ||
    normalized === "secret" ||
    normalized === "password" ||
    normalized === "apikey" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "oauth" ||
    normalized === "auth" ||
    normalized === "awssecretaccesskey"
  ) {
    return true;
  }

  if (
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken")
  ) {
    return true;
  }

  const parts = identifierParts(key);
  if (parts.some((part) => near(part, "token") || near(part, "secret") || near(part, "password"))) {
    return true;
  }

  return hasNearPair(parts, "api", "key") || hasNearPair(parts, "access", "token") || hasNearPair(parts, "refresh", "token");
}

function structuredCategoryForKey(key: string): RedactionCategory {
  const normalized = normalizeIdentifier(key);
  if (normalized === "awssecretaccesskey" || normalized.endsWith("awssecretaccesskey")) {
    return "aws_secret";
  }

  return "structured_secret";
}

function isSensitiveBasename(value: string): boolean {
  return KNOWN_SENSITIVE_BASENAMES.has(value.trim().toLowerCase());
}

function normalizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[авекмнорстух]/g, (letter) => CYRILLIC_LOOKALIKE_TO_LATIN[letter] ?? letter)
    .replace(/[^a-z0-9]+/g, "");
}

function identifierParts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9авекмнорстухАВЕКМНОРСТУХ]+/)
    .map(normalizeIdentifier)
    .filter(Boolean);
}

function hasNearPair(parts: string[], first: string, second: string): boolean {
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (near(parts[index], first) && near(parts[index + 1], second)) {
      return true;
    }
  }

  return false;
}

function near(actual: string, expected: string): boolean {
  if (actual === expected) {
    return true;
  }

  if (Math.abs(actual.length - expected.length) > 1) {
    return false;
  }

  return levenshteinAtMostOne(actual, expected);
}

function levenshteinAtMostOne(left: string, right: string): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) {
      return false;
    }

    if (left.length > right.length) {
      leftIndex += 1;
    } else if (right.length > left.length) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  return edits + (left.length - leftIndex) + (right.length - rightIndex) <= 1;
}

function marker(category: RedactionCategory): string {
  return `${REDACTED}:${category}`;
}

function createCounts(): MutableCounts {
  return { total: 0, categories: {} };
}

function addCount(counts: MutableCounts, category: RedactionCategory): void {
  counts.total += 1;
  counts.categories[category] = (counts.categories[category] ?? 0) + 1;
}

function mergeCounts(target: MutableCounts, source: RedactionCounts): void {
  target.total += source.total;
  for (const [category, count] of Object.entries(source.categories)) {
    target.categories[category] = (target.categories[category] ?? 0) + (count ?? 0);
  }
}

function freezeCounts(counts: MutableCounts): RedactionCounts {
  const categories: Partial<Record<RedactionCategory, number>> = {};
  for (const category of CATEGORY_ORDER) {
    if (counts.categories[category]) {
      categories[category] = counts.categories[category];
    }
  }

  return { total: counts.total, categories };
}

const CYRILLIC_LOOKALIKE_TO_LATIN: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
};
