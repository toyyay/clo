import { describe, expect, test } from "bun:test";
import { parseRoute, routeHash } from "./router";

describe("frontend router", () => {
  test("parses chat routes", () => {
    expect(parseRoute("#/chats/123")).toEqual({ chatId: "123", panel: undefined });
    expect(parseRoute("#/chats/abc%2Fdef/audio")).toEqual({ chatId: "abc/def", panel: "audio" });
    expect(parseRoute("#/chats/v2%3A123")).toEqual({ chatId: "v2:123", panel: undefined });
  });

  test("parses top-level panels", () => {
    expect(parseRoute("#/settings")).toEqual({ panel: "settings" });
    expect(parseRoute("#/audio")).toEqual({ panel: "audio" });
  });

  test("formats offline-safe hash routes", () => {
    expect(routeHash({})).toBe("#/");
    expect(routeHash({ chatId: "abc/def", panel: "settings" })).toBe("#/chats/abc%2Fdef/settings");
    expect(routeHash({ chatId: "v2:123" })).toBe("#/chats/v2%3A123");
  });
});
