import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { SessionEvent } from "../../packages/shared/types";

type TextPart = { kind: "text"; role: "user" | "assistant"; text: string };
type ThinkPart = { kind: "thinking"; text: string };
type ToolUseP = { kind: "tool_use"; name: string; input: any; id: string };
type ToolResP = { kind: "tool_result"; content: any; isError?: boolean; id: string };
export type FlatPart = TextPart | ThinkPart | ToolUseP | ToolResP;
type ToolGroup = { kind: "tool_group"; uses: ToolUseP[]; results: ToolResP[] };
export type RenderItem = TextPart | ThinkPart | ToolGroup;
type VirtualRange = { start: number; end: number; top: number; bottom: number };

const ROW_OVERSCAN = 8;
const DEFAULT_ROW_HEIGHT = 96;

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

function linkify(text: string) {
  const parts: (string | ReactElement)[] = [];
  const re = /(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a key={key++} href={m[1]} target="_blank" rel="noreferrer">
        {m[1]}
      </a>,
    );
    last = m.index + m[1].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function inlineMarkdown(text: string) {
  const out: (string | ReactElement)[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...linkify(text.slice(last, m.index)));
    out.push(<code key={`c${key++}`}>{m[1]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...linkify(text.slice(last)));
  return out;
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
  const paragraphs = text.split(/\n\n+/);
  return (
    <div className="asst-text">
      {paragraphs.map((p, i) => (
        <p key={i}>{inlineMarkdown(p)}</p>
      ))}
    </div>
  );
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
  const raf = useRef<number | null>(null);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0, top: 0, bottom: 0 });
  const [showBottom, setShowBottom] = useState(false);

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

  const updateRange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const viewportTop = el.scrollTop;
    const viewportBottom = viewportTop + el.clientHeight;
    const start = Math.max(0, lowerBound(layout.offsets, viewportTop) - ROW_OVERSCAN);
    const end = Math.min(items.length, lowerBound(layout.offsets, viewportBottom) + ROW_OVERSCAN);
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottom.current = bottomGap < 160;
    setShowBottom(bottomGap >= 160);
    setRange({
      start,
      end,
      top: layout.offsets[start] ?? 0,
      bottom: Math.max(0, layout.total - (layout.offsets[end] ?? layout.total)),
    });
  }, [items.length, layout]);

  const scheduleRange = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = window.requestAnimationFrame(() => {
      raf.current = null;
      updateRange();
    });
  }, [updateRange]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    nearBottom.current = true;
    setShowBottom(false);
    window.requestAnimationFrame(updateRange);
  }, [updateRange]);

  const onMeasure = useCallback((index: number, height: number) => {
    const rounded = Math.ceil(height);
    if (Math.abs((heights.current.get(index) ?? 0) - rounded) < 2) return;
    heights.current.set(index, rounded);
    setMeasureVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    heights.current.clear();
    pendingBottom.current = true;
    setMeasureVersion((version) => version + 1);
  }, [resetKey]);

  useEffect(() => {
    if (!items.length) {
      setRange({ start: 0, end: 0, top: 0, bottom: 0 });
      return;
    }
    updateRange();
    if (pendingBottom.current) {
      pendingBottom.current = false;
      window.requestAnimationFrame(scrollToBottom);
    } else if (nearBottom.current) {
      window.requestAnimationFrame(scrollToBottom);
    }
  }, [items.length, layout.total, scrollToBottom, updateRange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateRange);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateRange]);

  useEffect(() => {
    return () => {
      if (raf.current !== null) window.cancelAnimationFrame(raf.current);
    };
  }, []);

  return (
    <div ref={scrollRef} className="chat-scroll" onScroll={scheduleRange}>
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

function renderChatItem(it: RenderItem, i: number) {
  if (it.kind === "text" && it.role === "user")
    return (
      <div className="bubble-row">
        <div className="bubble">{inlineMarkdown(it.text)}</div>
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
