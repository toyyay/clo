import { describe, expect, test } from "bun:test";
import { canonicalizeSpec, evalPredicate, type Predicate, type ViewSpec } from "./contracts";

describe("canonicalizeSpec", () => {
  test("equivalent specs produce identical hash strings", () => {
    const a: ViewSpec = {
      id: "x",
      predicate: { all: [{ host: "macbook" }, { project: "food" }] },
      followNew: true,
      history: { tailItems: 200 },
    };
    const b: ViewSpec = {
      history: { tailItems: 200 },
      followNew: true,
      id: "x",
      predicate: { all: [{ host: "macbook" }, { project: "food" }] },
    };
    expect(canonicalizeSpec(a)).toBe(canonicalizeSpec(b));
  });

  test("different specs produce different strings", () => {
    const a: ViewSpec = { id: "x", predicate: { host: "a" } };
    const b: ViewSpec = { id: "x", predicate: { host: "b" } };
    expect(canonicalizeSpec(a)).not.toBe(canonicalizeSpec(b));
  });
});

describe("evalPredicate", () => {
  const chat = {
    hostId: "macbook",
    provider: "claude",
    projectKey: "food",
    sessionId: "v3:1234",
    lastSeenAt: "2026-05-01T00:00:00Z",
  };
  const now = Date.parse("2026-05-04T00:00:00Z");

  test("host matches", () => {
    expect(evalPredicate({ host: "macbook" }, chat, now)).toBe(true);
    expect(evalPredicate({ host: "other" }, chat, now)).toBe(false);
  });

  test("all + any combine", () => {
    const pred: Predicate = { all: [{ host: "macbook" }, { project: "food" }] };
    expect(evalPredicate(pred, chat, now)).toBe(true);
    const pred2: Predicate = { any: [{ host: "other" }, { project: "food" }] };
    expect(evalPredicate(pred2, chat, now)).toBe(true);
  });

  test("not inverts", () => {
    expect(evalPredicate({ not: { host: "macbook" } }, chat, now)).toBe(false);
    expect(evalPredicate({ not: { host: "other" } }, chat, now)).toBe(true);
  });

  test("lastSeenWithin", () => {
    expect(evalPredicate({ lastSeenWithin: { days: 30 } }, chat, now)).toBe(true);
    expect(evalPredicate({ lastSeenWithin: { days: 1 } }, chat, now)).toBe(false);
  });
});
