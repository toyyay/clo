import { describe, expect, test } from "bun:test";
import { READ_API_ENDPOINTS } from "./sync";

describe("frontend sync endpoints", () => {
  test("encodes v2 session ids in path segments", () => {
    expect(READ_API_ENDPOINTS.v2SessionEvents("v2:123")).toBe("/api/v2/sessions/v2%3A123/events");
  });
});
