import { useState, type ReactElement } from "react";
import { MarkdownText } from "../markdown";
import type { RenderItem, ToolGroup, ToolResP, ToolUseP } from "./types";

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

export function renderChatItem(it: RenderItem, i: number) {
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
