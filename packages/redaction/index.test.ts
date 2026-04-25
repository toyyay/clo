import { describe, expect, test } from "bun:test";
import { redactJsonValue, redactText, summarizeRedactions } from "./index";

describe("redactText", () => {
  test("redacts common API token shapes without keeping originals", () => {
    const slackToken = ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuv"].join("-");
    const input = [
      "openai=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "github=github_pat_11AAAAAAAAbbbbbbbbCCCCCCCCdddddddd",
      "classic=ghp_abcdefghijklmnopqrstuvwxyz123456",
      `slack=${slackToken}`,
      "auth Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n");

    const result = redactText(input);

    expect(result.value).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.value).not.toContain("github_pat_11AAAAAAAAbbbbbbbbCCCCCCCCdddddddd");
    expect(result.value).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(result.value).not.toContain(slackToken);
    expect(result.value).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result.redactions.total).toBe(5);
    expect(result.redactions.categories.api_token).toBe(4);
    expect(result.redactions.categories.bearer_token).toBe(1);
  });

  test("redacts jwt-looking values only when header and payload are JSON", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz012345";
    const random = "abcdefghijklmnop.qrstuvwxyz012345.abcdefghijklmnop";

    const result = redactText(`${jwt}\n${random}`);

    expect(result.value).toContain("[REDACTED]:jwt");
    expect(result.value).not.toContain(jwt);
    expect(result.value).toContain(random);
    expect(result.redactions.categories.jwt).toBe(1);
  });

  test("redacts private key and certificate blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "not-a-real-key",
      "-----END PRIVATE KEY-----",
      "-----BEGIN CERTIFICATE-----",
      "not-a-real-cert",
      "-----END CERTIFICATE-----",
    ].join("\n");

    const result = redactText(input);

    expect(result.value).not.toContain("not-a-real-key");
    expect(result.value).not.toContain("not-a-real-cert");
    expect(result.redactions.categories.private_key).toBe(1);
    expect(result.redactions.categories.certificate).toBe(1);
  });

  test("redacts env, JSON, and YAML sensitive values including small key typos", () => {
    const cyrillicO = "\u043e";
    const input = [
      "API_KEY=abc123",
      "pasword='typo-secret'",
      `t${cyrillicO}ken=lookalike-secret`,
      "\"refresh_token\": \"refresh-me\"",
      "oauth: oauth-value",
      "aws_secret_access_key = abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
    ].join("\n");

    const result = redactText(input);

    expect(result.value).not.toContain("abc123");
    expect(result.value).not.toContain("typo-secret");
    expect(result.value).not.toContain("lookalike-secret");
    expect(result.value).not.toContain("refresh-me");
    expect(result.value).not.toContain("oauth-value");
    expect(result.value).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN");
    expect(result.redactions.total).toBe(6);
    expect(result.redactions.categories.structured_secret).toBe(5);
    expect(result.redactions.categories.aws_secret).toBe(1);
  });

  test("redacts AWS key ids and sensitive basename paths", () => {
    const input = "key AKIA1234567890ABCDEF from ~/.config/chatview/auth.json and ./data/local storage";

    const result = redactText(input);

    expect(result.value).not.toContain("AKIA1234567890ABCDEF");
    expect(result.value).not.toContain("auth.json");
    expect(result.value).not.toContain("local storage");
    expect(result.redactions.categories.aws_key_id).toBe(1);
    expect(result.redactions.categories.sensitive_file).toBe(2);
  });
});

describe("redactJsonValue", () => {
  test("redacts nested sensitive keys and token-shaped string values", () => {
    const result = redactJsonValue({
      user: "alice",
      auth: {
        password: "never-store-me",
      },
      notes: ["token is sk-abcdefghijklmnopqrstuvwxyz123456"],
      "oauth_creds.json": {
        client_secret: "synthetic",
      },
    });

    expect(result.value.user).toBe("alice");
    expect(result.value.auth).toBe("[REDACTED]:structured_secret");
    expect(result.value.notes[0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.value["oauth_creds.json"]).toBe("[REDACTED]:sensitive_file");
    expect(result.redactions.categories.structured_secret).toBe(1);
    expect(result.redactions.categories.api_token).toBe(1);
    expect(result.redactions.categories.sensitive_file).toBe(1);
  });

  test("summarizes without adding original values", () => {
    const result = redactText("SECRET=value");
    const summary = summarizeRedactions(result);

    expect(summary).toEqual({
      total: 1,
      categories: { structured_secret: 1 },
    });
    expect(JSON.stringify(summary)).not.toContain("value");
  });
});
