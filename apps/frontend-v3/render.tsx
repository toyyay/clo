// Render switch — заменяет markdown.tsx + render-item.tsx + transform на клиенте.
//
// Здесь НЕТ react-markdown, НЕТ remark-gfm. Сервер уже посчитал RenderItem'ы;
// клиент лишь свитчит по `k` и рисует. Если в payload есть `blocks`, рендерим
// предпарсенные markdown-блоки (всё ещё без сторонних либ — простой свитч).

import type { MarkdownBlock, RenderItem } from "../../packages/sync-v3/contracts";

const LONG_PREVIEW_CHARS = 1200;

export function RenderItemView({
  item,
  longExpanded,
  onToggleLong,
}: {
  item: RenderItem;
  longExpanded?: boolean;
  onToggleLong?: () => void;
}) {
  switch (item.k) {
    case "t": {
      const isLong = onToggleLong !== undefined;
      const showFull = !isLong || longExpanded === true;
      const txt = showFull ? item.txt : item.txt.slice(0, LONG_PREVIEW_CHARS);
      const useBlocks = showFull && item.blocks;
      const body = useBlocks ? <Blocks blocks={item.blocks!} /> : <PlainText txt={txt} />;
      if (item.r === "u") {
        return (
          <div className="bubble-row">
            <div className={`bubble ${isLong && !showFull ? "msg-truncated" : ""}`}>
              <div className="msg-body">{body}</div>
              {isLong && (
                <button className="show-more-btn" onClick={onToggleLong} aria-expanded={showFull}>
                  {showFull ? "Show less" : `Show full (${formatCharCount(item.txt.length)})`}
                </button>
              )}
            </div>
          </div>
        );
      }
      return (
        <div className={`asst ${isLong && !showFull ? "msg-truncated" : ""}`}>
          <div className="msg-body">{body}</div>
          {isLong && (
            <button className="show-more-btn" onClick={onToggleLong} aria-expanded={showFull}>
              {showFull ? "Show less" : `Show full (${formatCharCount(item.txt.length)})`}
            </button>
          )}
        </div>
      );
    }
    case "th":
      return (
        <details className="thinking">
          <summary>thinking</summary>
          <div>
            <PlainText txt={item.txt} />
          </div>
        </details>
      );
    case "tu":
      return (
        <div className="tool tool-use">
          <div className="tool-name">{item.name}</div>
          <pre className="tool-input">{safeStringify(item.in)}</pre>
        </div>
      );
    case "tr":
      return (
        <div className={`tool tool-result ${item.isErr ? "is-err" : ""}`}>
          <pre className="tool-output">
            {item.out}
            {item.trunc && <span className="tool-trunc"> …truncated</span>}
          </pre>
        </div>
      );
    case "tg":
      return <div className="tool-group" />;
  }
}

function PlainText({ txt }: { txt: string }) {
  return (
    <>
      {txt.split(/\n\n+/).map((para, i) => (
        <p key={i} className="para">
          {para.split("\n").map((line, j, arr) => (
            <span key={j}>
              {line}
              {j < arr.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

function Blocks({ blocks }: { blocks: MarkdownBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return (
              <p key={i} className="para">
                {b.s}
              </p>
            );
          case "h":
            return <Heading key={i} level={b.lvl}>{b.s}</Heading>;
          case "code":
            return (
              <pre key={i} className="code-block" data-language={b.lang ?? ""}>
                <code>{b.s}</code>
              </pre>
            );
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => <li key={j}>{it}</li>)}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => <li key={j}>{it}</li>)}
              </ol>
            );
          case "quote":
            return <blockquote key={i}>{b.s}</blockquote>;
          case "hr":
            return <hr key={i} />;
        }
      })}
    </>
  );
}

function Heading({ level, children }: { level: 1 | 2 | 3 | 4 | 5 | 6; children: React.ReactNode }) {
  switch (level) {
    case 1:
      return <h1>{children}</h1>;
    case 2:
      return <h2>{children}</h2>;
    case 3:
      return <h3>{children}</h3>;
    case 4:
      return <h4>{children}</h4>;
    case 5:
      return <h5>{children}</h5>;
    case 6:
      return <h6>{children}</h6>;
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCharCount(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${(n / 1_000_000).toFixed(1)}M chars`;
}
