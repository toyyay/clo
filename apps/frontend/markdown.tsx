import { useMemo, type ReactElement } from "react";

type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; language?: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "rule" };

function inlineMarkdown(text: string, keyPrefix = "i"): (string | ReactElement)[] {
  const out: (string | ReactElement)[] = [];
  const re =
    /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|(https?:\/\/[^\s<)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const partKey = `${keyPrefix}-${key++}`;
    if (m[1] !== undefined) {
      out.push(<code key={partKey}>{m[1]}</code>);
    } else if (m[2] !== undefined && m[3] !== undefined) {
      out.push(
        <a key={partKey} href={m[3]} target="_blank" rel="noreferrer">
          {inlineMarkdown(m[2], `${partKey}-label`)}
        </a>,
      );
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push(<strong key={partKey}>{inlineMarkdown(m[4] ?? m[5], `${partKey}-strong`)}</strong>);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      out.push(<em key={partKey}>{inlineMarkdown(m[6] ?? m[7], `${partKey}-em`)}</em>);
    } else if (m[8] !== undefined) {
      const href = trimTrailingUrlPunctuation(m[8]);
      out.push(
        <a key={partKey} href={href.url} target="_blank" rel="noreferrer">
          {href.url}
        </a>,
      );
      if (href.trailing) out.push(href.trailing);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function trimTrailingUrlPunctuation(url: string) {
  const match = url.match(/^(.+?)([.,!?;:]+)?$/);
  return { url: match?.[1] ?? url, trailing: match?.[2] ?? "" };
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language: fence[1], text: body.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^([-*_])\1\1+$/.test(trimmed)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (looksLikeTable(lines, index)) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && splitTableRow(lines[index]).length > 1) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const listMatch = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = Boolean(listMatch[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index].match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
        if (!current || Boolean(current[2]) !== ordered) break;
        items.push(current[3]);
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoted: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoted.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoted.join("\n") });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function isBlockStart(lines: string[], index: number) {
  const trimmed = lines[index].trim();
  if (!trimmed) return false;
  if (/^```/.test(trimmed)) return true;
  if (/^(#{1,6})\s+/.test(trimmed)) return true;
  if (/^([-*_])\1\1+$/.test(trimmed)) return true;
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[index])) return true;
  if (trimmed.startsWith(">")) return true;
  return looksLikeTable(lines, index);
}

function looksLikeTable(lines: string[], index: number) {
  if (index + 1 >= lines.length) return false;
  const header = splitTableRow(lines[index]);
  const separator = splitTableRow(lines[index + 1]);
  return header.length > 1 && separator.length === header.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [trimmed];
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function MarkdownText({ text, className = "" }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return <div className={`markdown ${className}`.trim()}>{blocks.map(renderMarkdownBlock)}</div>;
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactElement {
  switch (block.kind) {
    case "heading":
      return (
        <div key={index} className={`markdown-heading h${Math.min(6, Math.max(1, block.level))}`}>
          {inlineMarkdown(block.text, `h${index}`)}
        </div>
      );
    case "code":
      return (
        <pre key={index} className="markdown-code">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote key={index}>
          {block.text.split(/\n+/).map((line, lineIndex) => (
            <p key={lineIndex}>{inlineMarkdown(line, `q${index}-${lineIndex}`)}</p>
          ))}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{inlineMarkdown(item, `li${index}-${itemIndex}`)}</li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div key={index} className="markdown-table-wrap">
          <table>
            <thead>
              <tr>
                {block.headers.map((header, cellIndex) => (
                  <th key={cellIndex}>{inlineMarkdown(header, `th${index}-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{inlineMarkdown(row[cellIndex] ?? "", `td${index}-${rowIndex}-${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={index} />;
    default:
      return <p key={index}>{inlineMarkdown(block.text, `p${index}`)}</p>;
  }
}
