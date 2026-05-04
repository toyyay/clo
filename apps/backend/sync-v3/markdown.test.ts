import { describe, expect, test } from "bun:test";
import { parseMarkdownBlocks } from "./markdown";

describe("parseMarkdownBlocks", () => {
  test("empty input", () => {
    expect(parseMarkdownBlocks("")).toEqual([]);
    expect(parseMarkdownBlocks("   \n\n")).toEqual([]);
  });

  test("plain paragraph", () => {
    expect(parseMarkdownBlocks("hello world")).toEqual([{ t: "p", s: "hello world" }]);
  });

  test("multi-line paragraph stays together", () => {
    expect(parseMarkdownBlocks("hello\nworld")).toEqual([{ t: "p", s: "hello\nworld" }]);
  });

  test("two paragraphs", () => {
    expect(parseMarkdownBlocks("a\n\nb")).toEqual([
      { t: "p", s: "a" },
      { t: "p", s: "b" },
    ]);
  });

  test("fenced code with language", () => {
    expect(parseMarkdownBlocks("```ts\nconst a = 1\n```")).toEqual([{ t: "code", lang: "ts", s: "const a = 1" }]);
  });

  test("fenced code without language", () => {
    expect(parseMarkdownBlocks("```\nplain\n```")).toEqual([{ t: "code", s: "plain" }]);
  });

  test("headings 1..6", () => {
    expect(parseMarkdownBlocks("# h1\n## h2\n### h3")).toEqual([
      { t: "h", lvl: 1, s: "h1" },
      { t: "h", lvl: 2, s: "h2" },
      { t: "h", lvl: 3, s: "h3" },
    ]);
  });

  test("unordered list", () => {
    expect(parseMarkdownBlocks("- a\n- b\n- c")).toEqual([{ t: "ul", items: ["a", "b", "c"] }]);
  });

  test("ordered list", () => {
    expect(parseMarkdownBlocks("1. a\n2. b\n3. c")).toEqual([{ t: "ol", items: ["a", "b", "c"] }]);
  });

  test("blockquote", () => {
    expect(parseMarkdownBlocks("> quote\n> line two")).toEqual([{ t: "quote", s: "quote\nline two" }]);
  });

  test("horizontal rule", () => {
    expect(parseMarkdownBlocks("---")).toEqual([{ t: "hr" }]);
    expect(parseMarkdownBlocks("***")).toEqual([{ t: "hr" }]);
  });

  test("mixed", () => {
    const md = "# Title\n\nsome text\n\n- a\n- b\n\n```js\nconsole.log(1)\n```";
    expect(parseMarkdownBlocks(md)).toEqual([
      { t: "h", lvl: 1, s: "Title" },
      { t: "p", s: "some text" },
      { t: "ul", items: ["a", "b"] },
      { t: "code", lang: "js", s: "console.log(1)" },
    ]);
  });

  test("code-fence containing a line that LOOKS like markdown is preserved verbatim", () => {
    const md = "```\n# not a heading\n- not a list\n```";
    const out = parseMarkdownBlocks(md);
    expect(out).toEqual([{ t: "code", s: "# not a heading\n- not a list" }]);
  });
});
