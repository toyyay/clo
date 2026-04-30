import { describe, expect, test } from "bun:test";
import { asciiFilenameFallback, attachmentContentDisposition, inlineContentDisposition, safeContentType } from "./http-headers";

describe("http header helpers", () => {
  test("keeps Content-Disposition ASCII-safe for unicode filenames", () => {
    const header = inlineContentDisposition("Calle de Ma\u0301laga 2.m4a")!;
    expect(header).toBe('inline; filename="Calle de Malaga 2.m4a"; filename*=UTF-8\'\'Calle%20de%20Ma%CC%81laga%202.m4a');
    expect(() => new Headers({ "content-disposition": header })).not.toThrow();
  });

  test("removes quoted-string delimiters and control characters from fallback filename", () => {
    expect(asciiFilenameFallback("bad\";\r\nname.m4a")).toBe("bad____name.m4a");
  });

  test("falls back from unsafe Content-Type values", () => {
    expect(safeContentType("audio/x-m4a")).toBe("audio/x-m4a");
    expect(safeContentType("audio/x-m4a\r\nx-bad: yes")).toBe("application/octet-stream");
    expect(safeContentType("аудио/m4a")).toBe("application/octet-stream");
  });

  test("uses the same filename encoding for attachments", () => {
    expect(attachmentContentDisposition("São Paulo.zip")).toBe(
      'attachment; filename="Sao Paulo.zip"; filename*=UTF-8\'\'S%C3%A3o%20Paulo.zip',
    );
  });
});
