import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { SessionEvent } from "../../packages/shared/types";

type TextPart = { kind: "text"; role: "user" | "assistant"; text: string };
type ThinkPart = { kind: "thinking"; text: string };
type ToolUseP = { kind: "tool_use"; name: string; input: any; id: string };
type ToolResP = { kind: "tool_result"; content: any; isError?: boolean; id: string };
export type FlatPart = TextPart | ThinkPart | ToolUseP | ToolResP;
type ToolGroup = { kind: "tool_group"; uses: ToolUseP[]; results: ToolResP[] };
export type RenderItem = TextPart | ThinkPart | ToolGroup;
type VirtualRange = { start: number; end: number; top: number; bottom: number };
type SavedScroll = { top: number; nearBottom: boolean };
type ScrollAnchor = { index: number; offset: number };
type UpdateRangeOptions = { captureAnchor?: boolean };

const ROW_OVERSCAN = 8;
const DEFAULT_ROW_HEIGHT = 96;
const SCROLL_STORAGE_PREFIX = "chatview:chat-scroll:";

export function flatten(events: SessionEvent[]): FlatPart[] {
  const out: FlatPart[] = [];
  for (const event of events) {
    const e: any = event.raw;
    if (e.type !== "user" && e.type !== "assistant") continue;
    const msg = e.message;
    if (!msg) continue;
    const role: "user" | "assistant" = msg.role;
    if (typeof msg.content === "string") {
      if (msg.content.trim()) out.push({ kind: "text", role, text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p.type === "text" && p.text?.trim()) out.push({ kind: "text", role, text: p.text });
        else if (p.type === "thinking" && p.thinking?.trim()) out.push({ kind: "thinking", text: p.thinking });
        else if (p.type === "tool_use") out.push({ kind: "tool_use", name: p.name, input: p.input, id: p.id });
        else if (p.type === "tool_result")
          out.push({ kind: "tool_result", content: p.content, isError: p.is_error, id: p.tool_use_id });
      }
    }
  }
  return out;
}

export function groupItems(flat: FlatPart[]): RenderItem[] {
  const out: RenderItem[] = [];
  let cur: ToolGroup | null = null;
  for (const p of flat) {
    if (p.kind === "tool_use" || p.kind === "tool_result") {
      if (!cur) {
        cur = { kind: "tool_group", uses: [], results: [] };
        out.push(cur);
      }
      if (p.kind === "tool_use") cur.uses.push(p);
      else cur.results.push(p);
    } else {
      cur = null;
      out.push(p);
    }
  }
  return out;
}

function summarizeGroup(g: ToolGroup): string {
  const counts: Record<string, number> = {};
  for (const u of g.uses) counts[u.name] = (counts[u.name] || 0) + 1;
  const phrases: string[] = [];
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("%", String(n)));
  if (counts.Bash) {
    phrases.push(plural(counts.Bash, "Ran a command", "Ran % commands"));
    delete counts.Bash;
  }
  if (counts.Write) {
    phrases.push(plural(counts.Write, "Created a file", "Created % files"));
    delete counts.Write;
  }
  if (counts.Edit) {
    phrases.push(plural(counts.Edit, "Edited a file", "Edited % files"));
    delete counts.Edit;
  }
  if (counts.Read) {
    phrases.push(plural(counts.Read, "Read a file", "Read % files"));
    delete counts.Read;
  }
  if (counts.TodoWrite) {
    phrases.push("Updated todos");
    delete counts.TodoWrite;
  }
  const rest = Object.values(counts).reduce((a, b) => a + b, 0);
  if (rest) phrases.push(plural(rest, "used a tool", "used % tools"));
  const anyErr = g.results.some((r) => r.isError);
  if (!phrases.length) return "Used tools";
  const joined = phrases.join(", ");
  return anyErr ? `${joined} (error)` : joined;
}

function truncate(s: string, n: number) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + `\n... (+${s.length - n} chars)` : s;
}

function stringifyToolResult(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((x: any) => (typeof x === "string" ? x : x?.text ?? JSON.stringify(x))).join("\n");
  return JSON.stringify(content, null, 2);
}

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

function MarkdownText({ text, className = "" }: { text: string; className?: string }) {
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
      return <blockquote key={index}>{block.text.split(/\n+/).map((line, lineIndex) => <p key={lineIndex}>{inlineMarkdown(line, `q${index}-${lineIndex}`)}</p>)}</blockquote>;
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

function ToolDetail({ use, result }: { use?: ToolUseP; result?: ToolResP }) {
  if (!use) {
    return result ? <pre className="detail-body">{truncate(stringifyToolResult(result.content), 4000)}</pre> : null;
  }

  const { name, input } = use;
  let body: ReactElement;
  switch (name) {
    case "Bash":
      body = (
        <>
          {input?.description && <div className="detail-desc">{input.description}</div>}
          <pre className="cmd">$ {input?.command}</pre>
        </>
      );
      break;
    case "Read":
      body = <div className="path">{input?.file_path}</div>;
      break;
    case "Write":
      body = (
        <>
          <div className="path">{input?.file_path}</div>
          <pre className="detail-body">{truncate(input?.content ?? "", 2000)}</pre>
        </>
      );
      break;
    case "Edit":
      body = (
        <>
          <div className="path">{input?.file_path}</div>
          <pre className="diff-old">- {truncate(input?.old_string ?? "", 800)}</pre>
          <pre className="diff-new">+ {truncate(input?.new_string ?? "", 800)}</pre>
        </>
      );
      break;
    case "Glob":
      body = (
        <div className="path">
          {input?.pattern}
          {input?.path ? ` in ${input.path}` : ""}
        </div>
      );
      break;
    case "Grep":
      body = (
        <div className="path">
          <b>{input?.pattern}</b>
          {input?.path ? ` in ${input.path}` : ""}
          {input?.glob ? ` (${input.glob})` : ""}
        </div>
      );
      break;
    case "TodoWrite":
      body = Array.isArray(input?.todos) ? (
        <ul className="todos">
          {input.todos.map((t: any, i: number) => (
            <li key={i} className={`todo-${t.status}`}>
              <span className="todo-box">{t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"}</span>
              {t.content}
            </li>
          ))}
        </ul>
      ) : (
        <pre>{JSON.stringify(input, null, 2)}</pre>
      );
      break;
    default:
      body = <pre>{JSON.stringify(input, null, 2)}</pre>;
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <span className="detail-tool">{name}</span>
      </div>
      {body}
      {result && (
        <div className={`detail-result ${result.isError ? "err" : ""}`}>
          <div className="detail-result-head">{result.isError ? "error" : "result"}</div>
          <pre className="detail-body">{truncate(stringifyToolResult(result.content), 3000)}</pre>
        </div>
      )}
    </div>
  );
}

function ToolGroupBlock({ group }: { group: ToolGroup }) {
  const [open, setOpen] = useState(false);
  const hasErr = group.results.some((r) => r.isError);
  const resById = new Map(group.results.map((r) => [r.id, r]));
  const orphanResults = group.results.filter((r) => !group.uses.find((u) => u.id === r.id));
  return (
    <div className={`tool-group ${hasErr ? "err" : ""}`}>
      <button className="tool-summary" onClick={() => setOpen((o) => !o)}>
        {hasErr && <span className="err-tag">Tool error</span>}
        <span className="summary-text">{summarizeGroup(group)}</span>
        <span className="chev">{open ? "v" : ">"}</span>
      </button>
      {open && (
        <div className="tool-details">
          {group.uses.map((u) => (
            <ToolDetail key={u.id} use={u} result={resById.get(u.id)} />
          ))}
          {orphanResults.map((r) => (
            <ToolDetail key={r.id} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantText({ text }: { text: string }) {
  return <MarkdownText text={text} className="asst-text" />;
}

function estimateItemHeight(item: RenderItem) {
  if (item.kind === "tool_group") return 34;
  if (item.kind === "thinking") return 44;
  const lines = Math.ceil(item.text.length / 96) + item.text.split("\n").length - 1;
  return Math.max(44, Math.min(420, 18 + lines * 22));
}

function VirtualRow({
  index,
  item,
  onMeasure,
}: {
  index: number;
  item: RenderItem;
  onMeasure: (index: number, height: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const measure = () => onMeasure(index, node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [index, onMeasure]);

  return (
    <div ref={rowRef} className="virtual-row">
      {renderChatItem(item, index)}
    </div>
  );
}

export function VirtualChat({ items, resetKey }: { items: RenderItem[]; resetKey: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<number, number>());
  const nearBottom = useRef(true);
  const pendingBottom = useRef(true);
  const restoredScrollKey = useRef<string | null>(null);
  const scrollAnchor = useRef<ScrollAnchor | null>(null);
  const raf = useRef<number | null>(null);
  const scrollRaf = useRef<number | null>(null);
  const pendingRangeCapture = useRef(false);
  const previousItemsLength = useRef(0);
  const resetKeyRef = useRef(resetKey);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0, top: 0, bottom: 0 });
  const [showBottom, setShowBottom] = useState(false);

  resetKeyRef.current = resetKey;

  const layout = useMemo(() => {
    const offsets = new Array(items.length + 1);
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
      offsets[i] = total;
      total += heights.current.get(i) ?? estimateItemHeight(items[i]) ?? DEFAULT_ROW_HEIGHT;
    }
    offsets[items.length] = total;
    return { offsets, total };
  }, [items, measureVersion]);

  const updateRange = useCallback((options: UpdateRangeOptions = {}) => {
    const el = scrollRef.current;
    if (!el) return;
    const viewportTop = el.scrollTop;
    const viewportBottom = viewportTop + el.clientHeight;
    const start = Math.max(0, lowerBound(layout.offsets, viewportTop) - ROW_OVERSCAN);
    const end = Math.min(items.length, lowerBound(layout.offsets, viewportBottom) + ROW_OVERSCAN);
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottom.current = bottomGap < 160;
    if (options.captureAnchor && !nearBottom.current) scrollAnchor.current = anchorForScroll(layout.offsets, viewportTop, items.length);
    setShowBottom(bottomGap >= 160);
    setRange({
      start,
      end,
      top: layout.offsets[start] ?? 0,
      bottom: Math.max(0, layout.total - (layout.offsets[end] ?? layout.total)),
    });
  }, [items.length, layout]);

  const scheduleRange = useCallback((options: UpdateRangeOptions = {}) => {
    pendingRangeCapture.current = pendingRangeCapture.current || Boolean(options.captureAnchor);
    if (raf.current !== null) return;
    raf.current = window.requestAnimationFrame(() => {
      raf.current = null;
      const captureAnchor = pendingRangeCapture.current;
      pendingRangeCapture.current = false;
      updateRange({ captureAnchor });
    });
  }, [updateRange]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) saveChatScroll(resetKey, el);
    scheduleRange({ captureAnchor: true });
  }, [resetKey, scheduleRange]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    nearBottom.current = true;
    setShowBottom(false);
    scheduleRange();
  }, [scheduleRange]);

  const cancelScrollFrame = useCallback(() => {
    if (scrollRaf.current !== null) {
      window.cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = null;
    }
  }, []);

  const scheduleScrollFrame = useCallback(
    (callback: () => void) => {
      cancelScrollFrame();
      const expectedResetKey = resetKeyRef.current;
      scrollRaf.current = window.requestAnimationFrame(() => {
        scrollRaf.current = null;
        if (resetKeyRef.current !== expectedResetKey) return;
        callback();
      });
    },
    [cancelScrollFrame],
  );

  const onMeasure = useCallback((index: number, height: number) => {
    const rounded = Math.ceil(height);
    if (Math.abs((heights.current.get(index) ?? 0) - rounded) < 2) return;
    heights.current.set(index, rounded);
    setMeasureVersion((version) => version + 1);
  }, []);

  useLayoutEffect(() => {
    cancelScrollFrame();
    heights.current.clear();
    scrollAnchor.current = null;
    nearBottom.current = true;
    const saved = loadChatScroll(resetKey);
    pendingBottom.current = !saved || saved.nearBottom;
    restoredScrollKey.current = null;
    previousItemsLength.current = 0;
    setRange({ start: 0, end: 0, top: 0, bottom: 0 });
    setShowBottom(false);
    setMeasureVersion((version) => version + 1);
  }, [cancelScrollFrame, resetKey]);

  useLayoutEffect(() => {
    if (!items.length) {
      previousItemsLength.current = 0;
      setRange({ start: 0, end: 0, top: 0, bottom: 0 });
      setShowBottom(false);
      return;
    }
    const wasNearBottom = nearBottom.current;
    const wasPendingBottom = pendingBottom.current;
    const appended = items.length > previousItemsLength.current;
    previousItemsLength.current = items.length;
    updateRange();
    const savedScroll = loadChatScroll(resetKey);
    if (savedScroll && !savedScroll.nearBottom && restoredScrollKey.current !== resetKey) {
      restoredScrollKey.current = resetKey;
      pendingBottom.current = false;
      scheduleScrollFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const nextTop = Math.min(savedScroll.top, Math.max(0, el.scrollHeight - el.clientHeight));
        el.scrollTop = nextTop;
        scrollAnchor.current = anchorForScroll(layout.offsets, nextTop, items.length);
        updateRange();
      });
      return;
    }
    if (wasPendingBottom) {
      pendingBottom.current = false;
      scheduleScrollFrame(scrollToBottom);
    } else if (appended && wasNearBottom) {
      scheduleScrollFrame(scrollToBottom);
    }
  }, [items.length, layout.total, resetKey, scheduleScrollFrame, scrollToBottom, updateRange]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = scrollAnchor.current;
    if (!el || !anchor || !items.length || nearBottom.current || pendingBottom.current) return;

    const index = Math.min(anchor.index, items.length - 1);
    const nextTop = clamp(
      (layout.offsets[index] ?? 0) + anchor.offset,
      0,
      Math.max(0, el.scrollHeight - el.clientHeight),
    );
    if (Math.abs(nextTop - el.scrollTop) < 1) return;
    el.scrollTop = nextTop;
    updateRange();
  }, [items.length, layout, updateRange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => scheduleRange());
    observer.observe(el);
    return () => observer.disconnect();
  }, [scheduleRange]);

  useEffect(() => {
    return () => {
      if (raf.current !== null) window.cancelAnimationFrame(raf.current);
      if (scrollRaf.current !== null) window.cancelAnimationFrame(scrollRaf.current);
    };
  }, []);

  return (
    <div ref={scrollRef} className="chat-scroll" onScroll={onScroll}>
      <div className="virtual-spacer" style={{ height: range.top }} />
      <div className="items">
        {items.slice(range.start, range.end).map((item, offset) => {
          const index = range.start + offset;
          return <VirtualRow key={`${resetKey}:${index}`} index={index} item={item} onMeasure={onMeasure} />;
        })}
      </div>
      <div className="virtual-spacer" style={{ height: range.bottom }} />
      {showBottom && (
        <button className="bottom-button" onClick={scrollToBottom}>
          Bottom
        </button>
      )}
    </div>
  );
}

function saveChatScroll(resetKey: string, el: HTMLDivElement) {
  try {
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const payload: SavedScroll = {
      top: Math.max(0, Math.round(el.scrollTop)),
      nearBottom: bottomGap < 160,
    };
    sessionStorage.setItem(`${SCROLL_STORAGE_PREFIX}${resetKey}`, JSON.stringify(payload));
  } catch {
    return;
  }
}

function loadChatScroll(resetKey: string): SavedScroll | null {
  try {
    const raw = sessionStorage.getItem(`${SCROLL_STORAGE_PREFIX}${resetKey}`);
    if (raw === null) return null;
    if (/^\d+$/.test(raw)) {
      const top = Number(raw);
      return Number.isFinite(top) ? { top, nearBottom: false } : null;
    }
    const parsed = JSON.parse(raw) as Partial<SavedScroll>;
    const top = Number(parsed.top);
    if (!Number.isFinite(top)) return null;
    return { top: Math.max(0, top), nearBottom: Boolean(parsed.nearBottom) };
  } catch {
    return null;
  }
}

function lowerBound(offsets: number[], value: number) {
  let lo = 0;
  let hi = Math.max(0, offsets.length - 1);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((offsets[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(offsets: number[], value: number) {
  let lo = 0;
  let hi = Math.max(0, offsets.length - 1);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((offsets[mid] ?? 0) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function anchorForScroll(offsets: number[], scrollTop: number, itemCount: number): ScrollAnchor | null {
  if (!itemCount) return null;
  const index = clamp(upperBound(offsets, scrollTop) - 1, 0, itemCount - 1);
  return { index, offset: scrollTop - (offsets[index] ?? 0) };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function renderChatItem(it: RenderItem, i: number) {
  if (it.kind === "text" && it.role === "user")
    return (
      <div className="bubble-row">
        <div className="bubble">
          <MarkdownText text={it.text} />
        </div>
      </div>
    );
  if (it.kind === "text") return <AssistantText text={it.text} />;
  if (it.kind === "thinking")
    return (
      <details className="thinking">
        <summary>thinking</summary>
        <div>{it.text}</div>
      </details>
    );
  return <ToolGroupBlock key={i} group={it} />;
}
