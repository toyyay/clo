import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import * as Y from "yjs";
import type {
  AppSettingsInfo,
  AudioTranscriptionInfo,
  HostInfo,
  ImportedAudioInfo,
  SessionEvent,
  SessionInfo,
} from "../../packages/shared/types";
import {
  clearBrowserCaches,
  getMeta,
  loadCacheStats,
  loadHosts,
  loadSessionEvents,
  loadSessions,
  resetIndexedDbCache,
  setMeta,
  unregisterServiceWorkers,
  type CacheStats,
} from "./db";
import {
  appendCachedAudioChunk,
  createCachedAudioRecording,
  deleteCachedAudioRecording,
  finalizeCachedAudioRecording,
  loadCachedAudioBlob,
  loadCachedAudioRecordings,
  markCachedAudioRecordingStatus,
  type CachedAudioRecording,
} from "./audio-cache";
import {
  AudioModal,
  FALLBACK_REASONING_EFFORTS,
  FALLBACK_TRANSCRIPTION_MODELS,
  chooseRecorderMimeType,
  extensionForMime,
  isAudioLikeFile,
  type AudioRetryOptions,
  type RecordingUiState,
  type TranscriptLanguage,
} from "./audio-panel";
import { pullUpdates, SyncAuthError } from "./sync";
import {
  docIdForSession,
  getDraft,
  loadDraftDoc,
  mergeCachedDraftUpdate,
  openYjsSocket,
  persistDraftDoc,
  sendYjsSocketUpdate,
  setDraft as setYDraft,
  subscribeYjsSocket,
  syncCachedDraftDocs,
  syncDraftDoc,
} from "./yjs";

type TextPart = { kind: "text"; role: "user" | "assistant"; text: string };
type ThinkPart = { kind: "thinking"; text: string };
type ToolUseP = { kind: "tool_use"; name: string; input: any; id: string };
type ToolResP = { kind: "tool_result"; content: any; isError?: boolean; id: string };
type FlatPart = TextPart | ThinkPart | ToolUseP | ToolResP;
type ToolGroup = { kind: "tool_group"; uses: ToolUseP[]; results: ToolResP[] };
type RenderItem = TextPart | ThinkPart | ToolGroup;
type SyncState = "loading" | "syncing" | "idle" | "offline" | "error";
type AuthState = "checking" | "authenticated" | "anonymous";
type VirtualRange = { start: number; end: number; top: number; bottom: number };

const ROW_OVERSCAN = 8;
const DEFAULT_ROW_HEIGHT = 96;

function flatten(events: SessionEvent[]): FlatPart[] {
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

function groupItems(flat: FlatPart[]): RenderItem[] {
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

function VirtualChat({ items, resetKey }: { items: RenderItem[]; resetKey: string }) {
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

function formatBytes(value?: number | null) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value?: string | null) {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function formatNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unknown";
}

function formatLimit(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unlimited";
}

function openRouterStatusLabel(settings: AppSettingsInfo | null) {
  const status = settings?.openRouter.status;
  if (status === "ok") return "ready";
  if (status === "checking") return "checking";
  if (status === "error") return "error";
  return "missing";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

function ModalFrame({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactElement | ReactElement[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button compact-button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function SettingsModal({
  settings,
  cacheStats,
  loading,
  message,
  onClose,
  onRefresh,
  onCopy,
  onCreateToken,
  onCheckOpenRouter,
  onResetIndexedDb,
  onClearCaches,
  onUnregisterServiceWorkers,
}: {
  settings: AppSettingsInfo | null;
  cacheStats: CacheStats | null;
  loading: boolean;
  message: string;
  onClose: () => void;
  onRefresh: () => void;
  onCopy: (value: string) => void;
  onCreateToken: () => void;
  onCheckOpenRouter: () => void;
  onResetIndexedDb: () => void;
  onClearCaches: () => void;
  onUnregisterServiceWorkers: () => void;
}) {
  const openRouter = settings?.openRouter;
  const openRouterReady = openRouter?.status === "ok";
  const openRouterKey = openRouter?.key;
  return (
    <ModalFrame title="Settings" onClose={onClose}>
      <div className="modal-body">
        <div className="settings-section">
          <div className="section-title">iPhone Upload</div>
          {settings?.importTokens.length ? (
            <div className="url-list">
              {settings.importTokens.map((token) => (
                <div className="url-row" key={token.id}>
                  <div className="url-meta">
                    <span>{token.label}</span>
                    <span>{token.tokenPreview} / last used {formatDate(token.lastUsedAt)}</span>
                  </div>
                  <code>{token.uploadUrl}</code>
                  <button className="icon-button compact-button" onClick={() => onCopy(token.uploadUrl)}>
                    Copy
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-text">No import tokens yet.</div>
          )}
          <button className="icon-button" onClick={onCreateToken} disabled={loading}>
            New token
          </button>
        </div>

        <div className="settings-section">
          <div className="section-title">OpenRouter</div>
          <div className={`service-status ${openRouterStatusLabel(settings)}`}>
            <span>{openRouterStatusLabel(settings)}</span>
            <b>{openRouter?.message ?? "OPENROUTER_API_KEY is not configured"}</b>
          </div>
          <div className="kv-grid">
            <span>Configured</span>
            <b>{openRouter?.configured ? "yes" : "no"}</b>
            <span>Model</span>
            <b>{openRouter?.model ?? "unknown"}</b>
            <span>Reasoning</span>
            <b>{openRouter?.reasoningEffort ?? "medium"}</b>
            <span>Key label</span>
            <b>{openRouterKey?.label ?? (openRouter?.configured ? "unknown" : "missing")}</b>
            <span>Limit remaining</span>
            <b>{openRouterReady ? formatLimit(openRouterKey?.limitRemaining) : "not available"}</b>
            <span>Usage</span>
            <b>{openRouterReady ? formatNumber(openRouterKey?.usage) : "not available"}</b>
            <span>Rate limit</span>
            <b>
              {typeof openRouterKey?.rateLimit?.requests === "number" && openRouterKey.rateLimit.requests > 0
                ? `${openRouterKey.rateLimit.requests.toLocaleString()} / ${openRouterKey.rateLimit.interval ?? "window"}`
                : "not available"}
            </b>
            <span>Checked</span>
            <b>{formatDate(openRouter?.checkedAt)}</b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onCheckOpenRouter} disabled={loading}>
              Check OpenRouter
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="section-title">Cache</div>
          <div className="kv-grid">
            <span>Storage</span>
            <b>
              {formatBytes(cacheStats?.storageUsageBytes)} / {formatBytes(cacheStats?.storageQuotaBytes)}
            </b>
            <span>IndexedDB</span>
            <b>{cacheStats ? Object.entries(cacheStats.indexedDb).map(([k, v]) => `${k}:${v}`).join(" ") : "loading"}</b>
            <span>Cache API</span>
            <b>{cacheStats?.cacheNames.length ?? 0}</b>
            <span>Service workers</span>
            <b>{cacheStats?.serviceWorkers ?? 0}</b>
          </div>
          <div className="settings-actions">
            <button className="icon-button" onClick={onRefresh} disabled={loading}>
              Refresh
            </button>
            <button className="icon-button" onClick={onResetIndexedDb} disabled={loading}>
              Reset IndexedDB
            </button>
            <button className="icon-button" onClick={onClearCaches} disabled={loading}>
              Clear caches
            </button>
            <button className="icon-button" onClick={onUnregisterServiceWorkers} disabled={loading}>
              Reset service workers
            </button>
          </div>
        </div>

        {message && <div className="modal-message">{message}</div>}
      </div>
    </ModalFrame>
  );
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authToken, setAuthToken] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeHost, setActiveHost] = useState("all");
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [query, setQuery] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [statusText, setStatusText] = useState("Loading cache");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 780px)").matches);
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettingsInfo | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [audioOpen, setAudioOpen] = useState(false);
  const [audioItems, setAudioItems] = useState<ImportedAudioInfo[]>([]);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [audioLanguage, setAudioLanguage] = useState<TranscriptLanguage>("ru");
  const [audioRetryingId, setAudioRetryingId] = useState("");
  const [audioUploadStatus, setAudioUploadStatus] = useState("");
  const [cachedAudioRecordings, setCachedAudioRecordings] = useState<CachedAudioRecording[]>([]);
  const [recordingState, setRecordingState] = useState<RecordingUiState>({
    active: false,
    elapsedMs: 0,
    chunkCount: 0,
    mimeType: "",
    error: "",
  });
  const syncing = useRef(false);
  const cachedAudioUploadRunning = useRef(false);
  const cachedAudioRecoveryStarted = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recordingChunkIndexRef = useRef(0);
  const recordingChunkWritesRef = useRef<Promise<void>[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const activeRef = useRef<SessionInfo | null>(null);
  const activeYDocId = useRef<string | null>(null);
  const yDocs = useRef(new Map<string, Y.Doc>());
  const ySocket = useRef<WebSocket | null>(null);
  const yPushTimers = useRef(new Map<string, number>());
  const isAuthenticated = authState === "authenticated";

  const checkAuth = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/status");
      const payload = (await response.json()) as { configured?: boolean; authenticated?: boolean };
      setAuthConfigured(Boolean(payload.configured));
      setAuthState(payload.authenticated ? "authenticated" : "anonymous");
      setAuthError(payload.configured ? "" : "WEB_TOKEN is not configured on the server.");
    } catch (error) {
      setAuthState("anonymous");
      setAuthError("Could not reach the auth endpoint.");
      console.error(error);
    }
  }, []);

  const login = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!authToken.trim() || authBusy) return;

      setAuthBusy(true);
      setAuthError("");
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: authToken }),
        });

        if (!response.ok) {
          setAuthError(response.status === 503 ? "WEB_TOKEN is not configured on the server." : "Token is not valid.");
          setAuthState("anonymous");
          return;
        }

        setAuthToken("");
        setAuthState("authenticated");
        setAuthConfigured(true);
      } catch (error) {
        setAuthError("Login failed.");
        console.error(error);
      } finally {
        setAuthBusy(false);
      }
    },
    [authBusy, authToken],
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch((error) => console.error(error));
    ySocket.current?.close();
    ySocket.current = null;
    activeYDocId.current = null;
    setHosts([]);
    setSessions([]);
    setActive(null);
    setEvents([]);
    setDraft("");
    cachedAudioRecoveryStarted.current = false;
    setAuthState("anonymous");
  }, []);

  const refreshSettings = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const [nextSettings, nextStats] = await Promise.all([
        fetchJson<AppSettingsInfo>("/api/app/settings"),
        loadCacheStats(),
      ]);
      setSettings(nextSettings);
      setCacheStats(nextStats);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not load settings");
    } finally {
      setSettingsBusy(false);
    }
  }, []);

  const copyText = useCallback(async (value: string) => {
    await navigator.clipboard.writeText(value);
    setSettingsMessage("Copied");
  }, []);

  const createImportToken = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      await fetchJson("/api/imports/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "iPhone Shortcut" }),
      });
      await refreshSettings();
      setSettingsMessage("Token created");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not create token");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const checkOpenRouter = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const nextSettings = await fetchJson<AppSettingsInfo["openRouter"]>("/api/app/openrouter/check", { method: "POST" });
      setSettings((current) => (current ? { ...current, openRouter: nextSettings } : current));
      setSettingsMessage(nextSettings.status === "ok" ? "OpenRouter check passed" : nextSettings.message ?? "OpenRouter check failed");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not check OpenRouter");
    } finally {
      setSettingsBusy(false);
    }
  }, []);

  const resetIndexedDb = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      await resetIndexedDbCache();
      setHosts([]);
      setSessions([]);
      setEvents([]);
      setActive(null);
      setDraft("");
      setCachedAudioRecordings([]);
      await refreshSettings();
      setSettingsMessage("IndexedDB cache reset");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not reset IndexedDB");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const clearCaches = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const count = await clearBrowserCaches();
      await refreshSettings();
      setSettingsMessage(`Cleared ${count} browser caches`);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not clear caches");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const resetServiceWorkers = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const count = await unregisterServiceWorkers();
      await refreshSettings();
      setSettingsMessage(`Unregistered ${count} service workers`);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "Could not reset service workers");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshSettings]);

  const refreshAudio = useCallback(async () => {
    setAudioLoading(true);
    setAudioError("");
    try {
      setAudioItems(await fetchJson<ImportedAudioInfo[]>("/api/imports/audio"));
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Could not load audio");
    } finally {
      setAudioLoading(false);
    }
  }, []);

  const refreshCachedAudioRecordings = useCallback(async () => {
    try {
      setCachedAudioRecordings(await loadCachedAudioRecordings());
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Could not load cached recordings");
    }
  }, []);

  const uploadAudioFiles = useCallback(
    async (files: File[]) => {
      const audioFiles = files.filter(isAudioLikeFile);
      if (!audioFiles.length) {
        setAudioUploadStatus("No audio files selected");
        return;
      }

      setAudioUploadStatus(`Uploading ${audioFiles.length} file${audioFiles.length === 1 ? "" : "s"}`);
      setAudioError("");
      try {
        const form = new FormData();
        for (const file of audioFiles) form.append("audio", file, file.name);
        form.append("source", "browser-file-upload");
        form.append("clientNow", new Date().toISOString());
        const result = await fetchJson<{ audioFiles?: number; mediaFiles?: number }>("/api/imports/audio/upload", {
          method: "POST",
          body: form,
        });
        setAudioUploadStatus(`Uploaded ${result.audioFiles ?? result.mediaFiles ?? audioFiles.length} audio file(s)`);
        await refreshAudio();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not upload audio";
        setAudioError(message);
        setAudioUploadStatus(message);
      }
    },
    [refreshAudio],
  );

  const flushCachedAudioUploads = useCallback(async () => {
    if (!isAuthenticated || cachedAudioUploadRunning.current) return;
    cachedAudioUploadRunning.current = true;
    setAudioError("");
    try {
      const records = await loadCachedAudioRecordings();
      setCachedAudioRecordings(records);
      for (const record of records) {
        if (record.id === recordingIdRef.current || record.status === "uploading") continue;
        await markCachedAudioRecordingStatus(record.id, "uploading");
        await refreshCachedAudioRecordings();
        setAudioUploadStatus(`Uploading cached ${record.filename}`);

        try {
          const blob = await loadCachedAudioBlob(record.id);
          const filename = record.filename || `recording-${record.createdAt}.${extensionForMime(blob.type || record.mimeType)}`;
          const form = new FormData();
          form.append("audio", blob, filename);
          form.append("source", "browser-recording");
          form.append("recordingId", record.id);
          form.append("recordedAt", record.createdAt);
          form.append("durationMs", String(record.durationMs));
          await fetchJson("/api/imports/audio/upload", { method: "POST", body: form });
          await deleteCachedAudioRecording(record.id);
          setAudioUploadStatus(`Uploaded cached ${filename}`);
          await refreshAudio();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not upload cached recording";
          await markCachedAudioRecordingStatus(record.id, "failed", message);
          setAudioUploadStatus(message);
        } finally {
          await refreshCachedAudioRecordings();
        }
      }
    } finally {
      cachedAudioUploadRunning.current = false;
    }
  }, [isAuthenticated, refreshAudio, refreshCachedAudioRecordings]);

  const stopAudioRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state !== "inactive") {
      try {
        recorder.requestData();
      } catch {
        // Some browsers do not allow requestData while stopping.
      }
      recorder.stop();
    }
  }, []);

  const startAudioRecording = useCallback(async () => {
    if (mediaRecorderRef.current?.state === "recording") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecordingState((current) => ({ ...current, error: "Audio recording is not available in this browser" }));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = chooseRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const cached = await createCachedAudioRecording(recorder.mimeType || mimeType || "audio/webm");
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingIdRef.current = cached.id;
      recordingStartedAtRef.current = Date.now();
      recordingChunkIndexRef.current = 0;
      recordingChunkWritesRef.current = [];
      setAudioUploadStatus("");
      setRecordingState({
        active: true,
        elapsedMs: 0,
        chunkCount: 0,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        error: "",
      });
      await refreshCachedAudioRecordings();

      recorder.ondataavailable = (event) => {
        if (!event.data.size || !recordingIdRef.current) return;
        const index = recordingChunkIndexRef.current;
        recordingChunkIndexRef.current += 1;
        const elapsedMs = Date.now() - recordingStartedAtRef.current;
        const write = appendCachedAudioChunk(recordingIdRef.current, index, event.data, elapsedMs).catch((error) => {
          setRecordingState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "Could not cache recording chunk",
          }));
        });
        recordingChunkWritesRef.current.push(write);
        setRecordingState((current) => ({ ...current, elapsedMs, chunkCount: index + 1 }));
      };
      recorder.onerror = (event) => {
        setRecordingState((current) => ({
          ...current,
          error: (event as ErrorEvent).message || "Recording failed",
        }));
      };
      recorder.onstop = () => {
        const recordingId = recordingIdRef.current;
        const elapsedMs = Date.now() - recordingStartedAtRef.current;
        if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        recordingStreamRef.current = null;
        recordingIdRef.current = null;
        const chunkWrites = recordingChunkWritesRef.current;
        recordingChunkWritesRef.current = [];
        setRecordingState((current) => ({ ...current, active: false, elapsedMs }));
        if (recordingId) {
          void Promise.allSettled(chunkWrites)
            .then(() => finalizeCachedAudioRecording(recordingId, elapsedMs))
            .then(refreshCachedAudioRecordings)
            .then(flushCachedAudioUploads)
            .catch((error) => {
              setRecordingState((current) => ({
                ...current,
                error: error instanceof Error ? error.message : "Could not finalize recording",
              }));
            });
        }
      };
      recorder.start(1000);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingState((current) => ({ ...current, elapsedMs: Date.now() - recordingStartedAtRef.current }));
      }, 1000);
    } catch (error) {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      setRecordingState((current) => ({
        ...current,
        active: false,
        error: error instanceof Error ? error.message : "Could not start audio recording",
      }));
    }
  }, [flushCachedAudioUploads, refreshCachedAudioRecordings]);

  const toggleAudioRecording = useCallback(() => {
    if (recordingState.active) stopAudioRecording();
    else void startAudioRecording();
  }, [recordingState.active, startAudioRecording, stopAudioRecording]);

  const retryAudioTranscription = useCallback(
    async (mediaId: string, options: AudioRetryOptions) => {
      setAudioRetryingId(mediaId);
      setAudioError("");
      try {
        await fetchJson<AudioTranscriptionInfo>("/api/imports/audio/transcriptions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mediaId, ...options }),
        });
        await refreshAudio();
      } catch (error) {
        setAudioError(error instanceof Error ? error.message : "Could not queue transcription");
      } finally {
        setAudioRetryingId("");
      }
    },
    [refreshAudio],
  );

  const deleteAudio = useCallback(
    async (mediaId: string) => {
      if (!window.confirm("Delete this audio and its transcriptions?")) return;
      setAudioRetryingId(mediaId);
      setAudioError("");
      try {
        await fetchJson(`/api/imports/audio?mediaId=${encodeURIComponent(mediaId)}`, { method: "DELETE" });
        setAudioItems((current) => current.filter((item) => item.id !== mediaId));
      } catch (error) {
        setAudioError(error instanceof Error ? error.message : "Could not delete audio");
      } finally {
        setAudioRetryingId("");
      }
    },
    [],
  );

  const insertTranscriptIntoDraft = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value) return;
      const nextDraft = draft.trim() ? `${draft.trim()}\n\n${value}` : value;
      const docId = active ? docIdForSession(active.id) : null;
      const doc = docId ? yDocs.current.get(docId) : null;
      if (doc) setYDraft(doc, nextDraft);
      else setDraft(nextDraft);
      setAudioOpen(false);
    },
    [active, draft],
  );

  const refreshCache = useCallback(async () => {
    const [nextHosts, nextSessions] = await Promise.all([loadHosts(), loadSessions()]);
    setHosts(nextHosts);
    setSessions(nextSessions);
    setActive((current) => current ?? nextSessions[0] ?? null);
    return { hosts: nextHosts, sessions: nextSessions };
  }, []);

  const syncNow = useCallback(async () => {
    if (!isAuthenticated) return;
    if (syncing.current) return;
    syncing.current = true;
    setSyncState("syncing");
    setStatusText("Syncing");
    try {
      const result = await pullUpdates({
        onProgress: ({ events, hasMore }) => {
          if (!events) return;
          setStatusText(hasMore ? `Syncing ${events.toLocaleString()} events…` : `Applying ${events.toLocaleString()} events…`);
        },
      });
      const { sessions: refreshedSessions } = await refreshCache();
      const current = activeRef.current;
      let activeRemoved = false;
      if (current) {
        const fresh = refreshedSessions.find((session) => session.id === current.id);
        if (!fresh || fresh.deletedAt) {
          const docId = activeYDocId.current;
          if (docId) {
            yDocs.current.delete(docId);
            activeYDocId.current = null;
          }
          setActive(null);
          setEvents([]);
          setDraft("");
          activeRemoved = true;
          console.warn("active session no longer available", current.id);
        } else if (result.events > 0) {
          setEvents(await loadSessionEvents(current.id));
        }
      }
      setSyncState("idle");
      setStatusText(
        activeRemoved ? "Active chat was removed" : result.events ? `Synced ${result.events} events` : "Up to date",
      );
    } catch (error) {
      if (error instanceof SyncAuthError) {
        cachedAudioRecoveryStarted.current = false;
        setAuthState("anonymous");
        setAuthError("Session expired. Enter the token again.");
      }
      setSyncState(navigator.onLine ? "error" : "offline");
      setStatusText(navigator.onLine ? "Sync failed" : "Offline cache");
      console.error(error);
    } finally {
      syncing.current = false;
    }
  }, [isAuthenticated, refreshCache]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (settingsOpen) refreshSettings();
  }, [refreshSettings, settingsOpen]);

  useEffect(() => {
    if (audioOpen) refreshAudio();
  }, [audioOpen, refreshAudio]);

  useEffect(() => {
    if (audioOpen) refreshCachedAudioRecordings();
  }, [audioOpen, refreshCachedAudioRecordings]);

  useEffect(() => {
    if (!isAuthenticated || cachedAudioRecoveryStarted.current) return;
    cachedAudioRecoveryStarted.current = true;
    void refreshCachedAudioRecordings().then(flushCachedAudioUploads);
  }, [flushCachedAudioUploads, isAuthenticated, refreshCachedAudioRecordings]);

  useEffect(() => {
    if (!audioOpen) return;
    const hasPending = audioItems.some((item) =>
      item.transcriptions.some((transcription) => transcription.status === "queued" || transcription.status === "processing"),
    );
    if (!hasPending) return;
    const id = window.setInterval(refreshAudio, 4000);
    return () => window.clearInterval(id);
  }, [audioItems, audioOpen, refreshAudio]);

  useEffect(() => {
    const flushActiveRecording = () => {
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "recording") {
        try {
          recorder.requestData();
        } catch {
          return;
        }
      }
    };
    document.addEventListener("visibilitychange", flushActiveRecording);
    window.addEventListener("beforeunload", flushActiveRecording);
    return () => {
      document.removeEventListener("visibilitychange", flushActiveRecording);
      window.removeEventListener("beforeunload", flushActiveRecording);
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    getMeta<"light" | "dark">("theme").then((stored) => {
      const next = stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      setTheme(next);
      document.documentElement.dataset.theme = next;
    });
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    refreshCache().then(() => syncNow());
  }, [isAuthenticated, refreshCache, syncNow]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const socket = openYjsSocket(async (docId, update) => {
      const doc = yDocs.current.get(docId);
      if (doc) {
        Y.applyUpdate(doc, update, "remote");
        await persistDraftDoc(docId, doc);
        if (activeYDocId.current === docId) setDraft(getDraft(doc));
      } else {
        await mergeCachedDraftUpdate(docId, update);
      }
    });
    ySocket.current = socket;
    return () => {
      socket.close();
      ySocket.current = null;
    };
  }, [isAuthenticated]);

  const scheduleYjsPush = useCallback((docId: string, sessionDbId: string, doc: Y.Doc, update: Uint8Array) => {
    sendYjsSocketUpdate(ySocket.current, docId, sessionDbId, update);
    const current = yPushTimers.current.get(docId);
    if (current) window.clearTimeout(current);
    const timer = window.setTimeout(() => {
      yPushTimers.current.delete(docId);
      syncDraftDoc(docId, sessionDbId, doc, true).catch((error) => console.error(error));
    }, 500);
    yPushTimers.current.set(docId, timer);
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of yPushTimers.current.values()) window.clearTimeout(timer);
      yPushTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setMeta("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!active) {
      setEvents([]);
      activeYDocId.current = null;
      setDraft("");
      return;
    }
    loadSessionEvents(active.id).then(setEvents);
  }, [active, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!active) return;
    const docId = docIdForSession(active.id);
    let disposed = false;
    let cleanup: (() => void) | null = null;
    activeYDocId.current = docId;

    loadDraftDoc(docId)
      .then(async (doc) => {
        if (disposed) return;
        yDocs.current.set(docId, doc);
        setDraft(getDraft(doc));
        subscribeYjsSocket(ySocket.current, [docId]);

        const onUpdate = (update: Uint8Array, origin: unknown) => {
          persistDraftDoc(docId, doc).catch((error) => console.error(error));
          if (activeYDocId.current === docId) setDraft(getDraft(doc));
          if (origin !== "remote" && origin !== "cache") scheduleYjsPush(docId, active.id, doc, update);
        };

        doc.on("update", onUpdate);
        cleanup = () => doc.off("update", onUpdate);
        await syncDraftDoc(docId, active.id, doc, true);
        if (!disposed) setDraft(getDraft(doc));

        if (disposed) cleanup();
      })
      .catch((error) => console.error(error));

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [active, isAuthenticated, scheduleYjsPush]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const id = window.setInterval(() => {
      if (!document.hidden) syncNow();
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) syncNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", syncNow);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", syncNow);
    };
  }, [isAuthenticated, syncNow]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (activeHost !== "all" && session.agentId !== activeHost) return false;
      if (!q) return true;
      return [session.hostname, session.projectName, session.title, session.sessionId, session.sourcePath]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [activeHost, query, sessions]);

  const items = useMemo(() => groupItems(flatten(events)), [events]);
  const yDocIdsToKeepWarm = useMemo(() => sessions.slice(0, 20).map((session) => docIdForSession(session.id)), [sessions]);
  const groupedSessions = useMemo(() => {
    const grouped = new Map<string, SessionInfo[]>();
    for (const session of filteredSessions) {
      const key = session.projectName || session.projectKey || "unknown";
      const list = grouped.get(key) ?? [];
      list.push(session);
      grouped.set(key, list);
    }
    const lastSeen = (list: SessionInfo[]) =>
      list.reduce((acc, s) => (s.lastSeenAt > acc ? s.lastSeenAt : acc), "");
    return [...grouped.entries()].sort(([, a], [, b]) => lastSeen(b).localeCompare(lastSeen(a)));
  }, [filteredSessions]);

  const selectSession = useCallback((session: SessionInfo) => {
    setActive(session);
    if (window.matchMedia("(max-width: 780px)").matches) setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    const topSessions = sessions.slice(0, 20);
    if (!topSessions.length) return;
    syncCachedDraftDocs(topSessions).catch((error) => console.error(error));
  }, [isAuthenticated, sessions]);

  useEffect(() => {
    if (!isAuthenticated) return;
    subscribeYjsSocket(ySocket.current, yDocIdsToKeepWarm);
  }, [isAuthenticated, yDocIdsToKeepWarm]);

  if (!isAuthenticated) {
    return (
      <div className="auth-page">
        <form className="auth-panel" onSubmit={login}>
          <div className="auth-brand">Chatview</div>
          <label className="auth-label" htmlFor="chatview-token">
            Token
          </label>
          <input
            id="chatview-token"
            className="auth-input"
            type="password"
            value={authToken}
            onChange={(event) => setAuthToken(event.target.value)}
            placeholder={authState === "checking" ? "Checking session" : "Enter token"}
            autoFocus
            autoComplete="current-password"
            disabled={authState === "checking" || authBusy || !authConfigured}
          />
          {authError && <div className="auth-error">{authError}</div>}
          <button className="auth-button" disabled={authState === "checking" || authBusy || !authConfigured || !authToken.trim()}>
            {authBusy ? "Signing in" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-closed"}`}>
      <header className="topbar">
        <div className="top-left">
          <button className="icon-button menu-button" onClick={() => setSidebarOpen((open) => !open)} title="Toggle chats">
            Chats
          </button>
          <div>
            <div className="brand">Chatview</div>
            {active && <div className="active-inline">{active.hostname} / {active.projectName}</div>}
          </div>
        </div>
        <div className="top-status">
          <div className={`sync-line ${syncState}`}>{statusText}</div>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={() => setAudioOpen(true)} title="Uploaded audio">
            Audio
          </button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings">
            Settings
          </button>
          <a className="icon-button download-button" href="/api/agent/download?arch=arm64">
            Download Mac Agent (M1)
          </a>
          <button className="icon-button" onClick={syncNow} disabled={syncState === "syncing"} title="Sync now">
            Sync
          </button>
          <button
            className="icon-button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            title="Toggle theme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button className="icon-button" onClick={logout} title="Sign out">
            Logout
          </button>
        </div>
      </header>

      <div className="layout">
        {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close chats" />}
        <aside className="sidebar">
          <div className="host-strip">
            <button className={`host-chip ${activeHost === "all" ? "active" : ""}`} onClick={() => setActiveHost("all")}>
              All
              <span>{sessions.length}</span>
            </button>
            {hosts.map((host) => (
              <button
                key={host.agentId}
                className={`host-chip ${activeHost === host.agentId ? "active" : ""}`}
                onClick={() => setActiveHost(host.agentId)}
              >
                {host.hostname}
                <span>{host.sessionCount}</span>
              </button>
            ))}
          </div>

          <input
            className="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            autoCapitalize="none"
          />

          <div className="session-list">
            {groupedSessions.map(([project, projectSessions]) => (
              <div key={project} className="session-group">
                <div className="session-group-head">
                  <span>{project}</span>
                  <span>{projectSessions.length}</span>
                </div>
                {projectSessions.map((session) => (
                  <button
                    key={session.id}
                    className={`session-item ${active?.id === session.id ? "active" : ""}`}
                    onClick={() => selectSession(session)}
                  >
                    <span className="session-title">{session.title || session.sessionId.slice(0, 8)}</span>
                    <span className="session-meta">
                      {session.hostname} / {session.eventCount}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <main className="main">
          {!active && <div className="empty">No cached chats yet</div>}
          {active && (
            <div className="chat">
              <div className="chat-head">
                <div>
                  <div className="chat-title">{active.title || active.sessionId}</div>
                  <div className="chat-subtitle">
                    {active.hostname} / {active.projectName}
                  </div>
                </div>
                <div className="chat-count">{events.length}</div>
              </div>

              <VirtualChat items={items} resetKey={active.id} />

              <div className="composer">
                <textarea
                  value={draft}
                  onChange={(event) => {
                    const docId = active ? docIdForSession(active.id) : null;
                    const doc = docId ? yDocs.current.get(docId) : null;
                    if (doc) setYDraft(doc, event.target.value);
                    else setDraft(event.target.value);
                  }}
                  placeholder="Reply..."
                  rows={2}
                />
                <button className="send-button" disabled title="UI only for now">
                  Send
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          cacheStats={cacheStats}
          loading={settingsBusy}
          message={settingsMessage}
          onClose={() => setSettingsOpen(false)}
          onRefresh={refreshSettings}
          onCopy={copyText}
          onCreateToken={createImportToken}
          onCheckOpenRouter={checkOpenRouter}
          onResetIndexedDb={resetIndexedDb}
          onClearCaches={clearCaches}
          onUnregisterServiceWorkers={resetServiceWorkers}
        />
      )}
      {audioOpen && (
        <AudioModal
          items={audioItems}
          loading={audioLoading}
          error={audioError}
          language={audioLanguage}
          busyMediaId={audioRetryingId}
          uploadStatus={audioUploadStatus}
          recording={recordingState}
          cachedRecordings={cachedAudioRecordings}
          models={settings?.transcriptionModels?.length ? settings.transcriptionModels : FALLBACK_TRANSCRIPTION_MODELS}
          reasoningEfforts={settings?.reasoningEfforts?.length ? settings.reasoningEfforts : FALLBACK_REASONING_EFFORTS}
          onLanguage={setAudioLanguage}
          onRefresh={refreshAudio}
          onUploadFiles={uploadAudioFiles}
          onFlushCache={flushCachedAudioUploads}
          onToggleRecording={toggleAudioRecording}
          onRetry={retryAudioTranscription}
          onDelete={deleteAudio}
          onInsert={insertTranscriptIntoDraft}
          onClose={() => setAudioOpen(false)}
        />
      )}
    </div>
  );
}
