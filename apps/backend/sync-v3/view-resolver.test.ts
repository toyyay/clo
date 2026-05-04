import { describe, expect, test } from "bun:test";
import { resolvePredicate, parseV3SessionId, v3SessionIdFromSourceFileId } from "./view-resolver";

describe("resolvePredicate", () => {
  test("simple host predicate", () => {
    const r = resolvePredicate({ host: "macbook" });
    expect(r.sql).toContain("r.agent_id = $1");
    expect(r.sql).toContain("hostname = $2");
    expect(r.params).toEqual(["macbook", "macbook"]);
  });

  test("project predicate", () => {
    const r = resolvePredicate({ project: "food" });
    expect(r.sql).toBe("(r.project_key = $1)");
    expect(r.params).toEqual(["food"]);
  });

  test("provider predicate", () => {
    const r = resolvePredicate({ provider: "claude" });
    expect(r.sql).toBe("(r.provider = $1)");
    expect(r.params).toEqual(["claude"]);
  });

  test("all() with mixed predicates", () => {
    const r = resolvePredicate({ all: [{ host: "mb" }, { project: "food" }, { provider: "claude" }] });
    expect(r.sql).toContain("AND");
    expect(r.params).toEqual(["mb", "mb", "food", "claude"]);
  });

  test("any() with two predicates", () => {
    const r = resolvePredicate({ any: [{ project: "a" }, { project: "b" }] });
    expect(r.sql).toContain("OR");
    expect(r.params).toEqual(["a", "b"]);
  });

  test("not() inverts", () => {
    const r = resolvePredicate({ not: { provider: "codex" } });
    expect(r.sql).toContain("NOT");
    expect(r.params).toEqual(["codex"]);
  });

  test("sessionId v3:N is parsed to integer", () => {
    const r = resolvePredicate({ sessionId: "v3:1234" });
    expect(r.params).toEqual([1234]);
  });

  test("invalid sessionId becomes FALSE", () => {
    const r = resolvePredicate({ sessionId: "garbage" });
    expect(r.sql).toBe("FALSE");
    expect(r.params).toEqual([]);
  });

  test("lastSeenWithin", () => {
    const r = resolvePredicate({ lastSeenWithin: { days: 7 } });
    expect(r.sql).toContain("now() -");
    expect(r.params).toEqual([7]);
  });

  test("empty all() = TRUE", () => {
    const r = resolvePredicate({ all: [] });
    expect(r.sql).toBe("TRUE");
  });

  test("empty any() = FALSE", () => {
    const r = resolvePredicate({ any: [] });
    expect(r.sql).toBe("FALSE");
  });

  test("nested all+any+not preserves placeholder ordering", () => {
    const r = resolvePredicate({
      all: [
        { host: "mb" },                                    // 2 params
        { any: [{ project: "a" }, { project: "b" }] },     // 2 params
        { not: { provider: "codex" } },                    // 1 param
      ],
    });
    expect(r.params).toEqual(["mb", "mb", "a", "b", "codex"]);
    expect(r.sql.match(/\$1/g)?.length).toBe(1);
    expect(r.sql.match(/\$5/g)?.length).toBe(1);
  });

  test("startOffset shifts placeholders", () => {
    const r = resolvePredicate({ host: "mb" }, 10);
    expect(r.sql).toContain("$10");
    expect(r.sql).toContain("$11");
  });
});

describe("parseV3SessionId", () => {
  test("v3 prefix", () => {
    expect(parseV3SessionId("v3:42")).toBe(42);
  });
  test("numeric only", () => {
    expect(parseV3SessionId("99")).toBe(99);
  });
  test("garbage", () => {
    expect(parseV3SessionId("xxx")).toBe(null);
    expect(parseV3SessionId("v3:abc")).toBe(null);
  });
});

describe("v3SessionIdFromSourceFileId", () => {
  test("formats", () => {
    expect(v3SessionIdFromSourceFileId(42)).toBe("v3:42");
    expect(v3SessionIdFromSourceFileId("42")).toBe("v3:42");
  });
});
