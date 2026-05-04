// Minimal markdown → MarkdownBlock parser.
//
// Designed to be:
//   • Cheap (single-pass, no regex catastrophic backtracking, no AST DAG).
//   • Safe (no HTML passthrough — block parser only).
//   • Useful (covers the 90% case: paragraphs, fenced code, headings,
//     bullet/ordered lists, blockquotes, horizontal rules).
//
// Inline markdown (**bold**, [links], `code`) is intentionally NOT expanded —
// it is preserved as-is in the block's text and the client renders it as
// plain text. We can layer inline parsing later without changing the contract.
//
// Used by the render pipeline to produce RenderItem.blocks for text payloads,
// so the client doesn't need react-markdown or remark-gfm.

import type { MarkdownBlock } from "../../../packages/sync-v3/contracts";

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  if (!input || !input.trim()) return [];
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: MarkdownBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    const fence = /^```([\w+\-.]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || undefined;
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing ```
      out.push({ t: "code", lang, s: buf.join("\n") });
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ t: "h", lvl: h[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, s: h[2]! });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:[-*_])\s*(?:[-*_]\s*){2,}$/.test(line)) {
      out.push({ t: "hr" });
      i += 1;
      continue;
    }

    // Blockquote (collapse multiple > lines)
    if (/^\s{0,3}>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      out.push({ t: "quote", s: buf.join("\n").trim() });
      continue;
    }

    // Unordered list
    if (/^\s{0,3}[-*+]\s+\S/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s{0,3}[-*+]\s+\S/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s{0,3}[-*+]\s+/, ""));
        i += 1;
      }
      out.push({ t: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s{0,3}\d+[.)]\s+\S/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s{0,3}\d+[.)]\s+\S/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s{0,3}\d+[.)]\s+/, ""));
        i += 1;
      }
      out.push({ t: "ol", items });
      continue;
    }

    // Blank line — skip
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph: gather lines until blank or another block-starter.
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      if (cur.trim() === "") break;
      if (/^```/.test(cur)) break;
      if (/^#{1,6}\s+/.test(cur)) break;
      if (/^\s*[-*_]\s*[-*_]\s*[-*_]/.test(cur)) break;
      if (/^\s{0,3}>\s?/.test(cur)) break;
      if (/^\s{0,3}[-*+]\s+\S/.test(cur)) break;
      if (/^\s{0,3}\d+[.)]\s+\S/.test(cur)) break;
      paraLines.push(cur);
      i += 1;
    }
    if (paraLines.length) {
      out.push({ t: "p", s: paraLines.join("\n") });
    }
  }

  return out;
}
