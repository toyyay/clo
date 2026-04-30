import { describe, expect, test } from "bun:test";
import { sanitizePostgresJson, sanitizePostgresText } from "./postgres-sanitize";

describe("postgres sanitizers", () => {
  test("scrubs null bytes and malformed surrogate pairs from text", () => {
    expect(sanitizePostgresText("before\u0000after")).toBe("before<nul>after");
    expect(sanitizePostgresText("bad\uD800value")).toBe("bad\uFFFDvalue");
  });

  test("scrubs jsonb-bound strings and object keys recursively", () => {
    expect(
      sanitizePostgresJson({
        "bad\u0000key": ["ok\u0000value", Number.POSITIVE_INFINITY],
        nested: { value: "bad\uDC00tail" },
      }),
    ).toEqual({
      "bad<nul>key": ["ok<nul>value", null],
      nested: { value: "bad\uFFFDtail" },
    });
  });
});
