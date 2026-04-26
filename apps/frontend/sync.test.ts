import { describe, expect, test } from "bun:test";
import { metadataModeForCursor, metadataPruneMode, READ_API_ENDPOINTS } from "./sync";

describe("frontend sync endpoints", () => {
  test("encodes v2 session ids in path segments", () => {
    expect(READ_API_ENDPOINTS.v2SessionEvents("v3:123")).toBe("/api/v2/sessions/v3%3A123/events");
  });

  test("requests a full metadata shell before switching to delta mode", () => {
    expect(metadataModeForCursor()).toBe("full");
    expect(metadataModeForCursor("meta:abc")).toBe("delta");
  });

  test("only prunes IndexedDB shell for authoritative metadata snapshots", () => {
    expect(metadataPruneMode({ metadataFull: true, metadataMode: "full" })).toBe("full-shell");
    expect(metadataPruneMode({ metadataFull: false, metadataMode: "delta" }, "meta:abc")).toBe("none");
    expect(metadataPruneMode({ metadataMode: "delta" })).toBe("none");
  });
});
