import { describe, expect, test } from "bun:test";
import { filenameFromContentDisposition } from "./media-detect";

describe("media detect helpers", () => {
  test("sanitizes filenames from Content-Disposition", () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''bad%00name.m4a")).toBe("bad<nul>name.m4a");
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''bad%ZZname.m4a")).toBe("bad%ZZname.m4a");
  });
});
