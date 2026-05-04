// Virtual chat view со sliding window.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RenderItem } from "../../packages/sync-v3/contracts";
import * as idb from "./idb";
import { RenderItemView } from "./render";
import { useStore, useStoreState } from "./store-hook";
import { formatBytes, formatRelative } from "./format";
import { BEFORE_VISUAL_CHANGE, AFTER_VISUAL_CHANGE } from "./settings";

const ROW_OVERSCAN = 6;
const LOAD_EDGE_PX = 720;
const MEASURE_FLUSH_MS = 80;
const HEIGHT_DELTA_THRESHOLD_PX = 6;
const NEAR_BOTTOM_PX = 200;

export function ChatView() {
  const state = useStoreState();
  if (state.loadingChat && (!state.activeChat || !state.activeWindow)) {
    return <ChatSkeleton chatId={state.loadingChat} />;
  }
  if (!state.activeChat || !state.activeWindow) {
    return <ChatPlaceholder />;
  }
  return <ActiveChat key={state.activeChat} chatId={state.activeChat} />;
}

function ChatPlaceholder() {
  const state = useStoreState();
  const isOffline = state.status.kind === "closed" || state.status.kind === "reconnecting";
  return (
    <main className="chat-view">
      <div className="chat-empty">
        {isOffline
          ? "Offline. Cached chats are still browsable from the sidebar."
          : "Select a chat from the sidebar."}
      </div>
    </main>
  );
}

function ChatSkeleton({ chatId }: { chatId: string }) {
  const state = useStoreState();
  const meta = state.visibleChats.get(chatId);
  return (
    <main className="chat-view">
      <div className="chat-scroll">
        <div className="chat-list chat-skeleton-list">
          <SkeletonRow role="user" lines={2} />
          <SkeletonRow role="assistant" lines={4} />
          <SkeletonTool />
          <SkeletonRow role="assistant" lines={3} />
          <SkeletonRow role="user" lines={1} />
        </div>
      </div>
      <div className="composer">
        <textarea
          className="composer-input"
          disabled
          placeholder={`Loading ${meta?.title ?? chatId}…`}
          rows={2}
        />
        <button className="composer-send" disabled>Send</button>
      </div>
    </main>
  );
}

function SkeletonRow({ role, lines }: { role: "user" | "assistant"; lines: number }) {
  return (
    <div className={`msg ${role === "assistant" ? "msg-asst" : "msg-user"} msg-skeleton`}>
      <div className="msg-role">{role}</div>
      <div className="msg-body">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="skeleton-line" style={{ width: `${85 - (i * 9) % 35}%` }} />
        ))}
      </div>
    </div>
  );
}

function SkeletonTool() {
  return (
    <div className="tool tool-use msg-skeleton">
      <div className="tool-head">
        <span className="skeleton-line" style={{ width: 80, height: 12 }} />
      </div>
      <div className="tool-input">
        <div className="skeleton-line" style={{ width: "70%" }} />
        <div className="skeleton-line" style={{ width: "55%" }} />
      </div>
    </div>
  );
}

function ActiveChat({ chatId }: { chatId: string }) {
  const store = useStore();
  const state = useStoreState();
  const activeWindow = state.activeWindow;
  const items = activeWindow?.items ?? [];
  const chatMeta = state.visibleChats.get(chatId);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const pendingHeights = useRef<Map<string, number>>(new Map());
  const measureRaf = useRef<number | null>(null);
  const heightsHydrated = useRef(false);
  const initialScrollDone = useRef(false);

  // ---- Scroll anchoring ----------------------------------------------------
  // Before any layout-shifting operation we capture the top-visible item key
  // and the offset of scrollTop within that item. After the layout pass we
  // find the same item's NEW offset and re-pin scrollTop. This is what keeps
  // the visible content perfectly stable when:
  //   • measurements arrive and rows get taller/shorter
  //   • loadOlder prepends a batch of items
  //   • font-scale changes
  //   • the user collapses/expands a tool group (future)
  // Without this, scrollTop is interpreted as absolute pixels into a list
  // that just changed underneath, so the user sees content jump.
  const anchorRef = useRef<{ key: string; withinItem: number } | null>(null);
  const anchoringActive = useRef(false);

  const [measureVersion, setMeasureVersion] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number; topPad: number; botPad: number }>({
    start: 0,
    end: 0,
    topPad: 0,
    botPad: 0,
  });
  const [showBottomButton, setShowBottomButton] = useState(false);

  // Hydrate heights from IDB once per chat.
  useEffect(() => {
    let cancelled = false;
    void idb.getHeightsForChat(chatId).then((map) => {
      if (cancelled) return;
      heightsRef.current = map;
      heightsHydrated.current = true;
      setMeasureVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const itemKeys = useMemo(() => items.map((it) => idb.itemKey(it)), [items]);

  const layout = useMemo(() => {
    const offsets = new Array<number>(items.length + 1);
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
      offsets[i] = total;
      const h = heightsRef.current.get(itemKeys[i]!) ?? estimateHeight(items[i]!);
      total += h;
    }
    offsets[items.length] = total;
    return { offsets, total };
  }, [items, itemKeys, measureVersion]);

  /** Capture the topmost visible item + offset within it, BEFORE any layout
   *  shift. Sets anchoringActive=true so onScroll knows the upcoming
   *  scrollTop change is programmatic and not user-driven. */
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !items.length) return;
    const top = el.scrollTop;
    const i = lowerBound(layout.offsets, top);
    const idx = Math.max(0, i - (layout.offsets[i] === top ? 0 : 1));
    const key = itemKeys[idx];
    if (!key) return;
    const offset = layout.offsets[idx] ?? 0;
    anchorRef.current = { key, withinItem: top - offset };
    anchoringActive.current = true;
  }, [items.length, itemKeys, layout]);

  /** PREPEND DETECT — must run before the anchor restore useLayoutEffect so
   *  the anchor is set in time. Whenever items.length grew AND an old key
   *  is now at a non-zero index, that's a prepend (loadOlder) and we anchor. */
  const prevItemKeysRef = useRef<string[]>([]);
  const prevScrollTopRef = useRef(0);
  useLayoutEffect(() => {
    const prev = prevItemKeysRef.current;
    if (prev.length && items.length > prev.length) {
      const firstPrevKey = prev[0]!;
      const newIdx = itemKeys.indexOf(firstPrevKey);
      if (newIdx > 0) {
        anchorRef.current = { key: firstPrevKey, withinItem: prevScrollTopRef.current };
        anchoringActive.current = true;
      }
    }
    prevItemKeysRef.current = itemKeys;
    prevScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
  });  // every render — cheap

  /** ANCHOR RESTORE — after layout has changed, find the anchored key's
   *  new offset and set scrollTop to keep the visible content pinned. */
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    const el = scrollRef.current;
    if (!el) return;
    const idx = itemKeys.indexOf(a.key);
    if (idx < 0) {
      anchorRef.current = null;
      anchoringActive.current = false;
      return;
    }
    const newOffset = layout.offsets[idx] ?? 0;
    const newTop = newOffset + a.withinItem;
    if (Math.abs(el.scrollTop - newTop) > 0.5) {
      el.scrollTop = newTop;
    }
    anchorRef.current = null;
    requestAnimationFrame(() => {
      anchoringActive.current = false;
    });
  }, [itemKeys, layout]);

  const updateRange = useCallback(
    (checkEdgeLoad = false) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = el.scrollTop;
      const bot = top + el.clientHeight;
      const start = Math.max(0, lowerBound(layout.offsets, top) - ROW_OVERSCAN);
      const end = Math.min(items.length, lowerBound(layout.offsets, bot) + ROW_OVERSCAN);
      const topPad = layout.offsets[start] ?? 0;
      const botPad = layout.total - (layout.offsets[end] ?? layout.total);
      setRange((cur) =>
        cur.start === start && cur.end === end && cur.topPad === topPad && cur.botPad === botPad
          ? cur
          : { start, end, topPad, botPad },
      );

      const distFromBottom = layout.total - bot;
      setShowBottomButton(distFromBottom > NEAR_BOTTOM_PX);

      if (checkEdgeLoad && top < LOAD_EDGE_PX && activeWindow?.hasOlder) {
        void store.loadOlder();
      }
    },
    [items.length, layout, store, activeWindow?.hasOlder],
  );

  useEffect(() => {
    updateRange(false);
  }, [updateRange]);

  // Auto-scroll to the bottom on first paint after the chat opens —
  // matches the legacy "open chat → see latest message" expectation.
  //
  // Use el.scrollHeight (real DOM, not layout.total) and assign it inside a
  // double-RAF so both `range` (which sets paddingTop/Bottom) and the layout
  // pass that consumes it have happened before we scroll. Otherwise scrollTop
  // gets silently clamped to (scrollHeight - clientHeight) on a partial DOM
  // and we end up at the top.
  //
  // Effect re-runs as layout.total grows (heights hydrate) and stops once the
  // user scrolls manually OR distance-from-bottom is < 4px.
  const userScrolled = useRef(false);
  useLayoutEffect(() => {
    if (initialScrollDone.current) return;
    if (!items.length) return;
    if (userScrolled.current) {
      initialScrollDone.current = true;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    if (layout.total <= el.clientHeight) {
      initialScrollDone.current = true;
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (!el2) return;
        if (userScrolled.current || initialScrollDone.current) return;
        // Mark anchoring so onScroll won't latch userScrolled from our own
        // programmatic assignment — otherwise we lock in at scrollHeight that
        // was correct BEFORE heights hydrated, and end up ~845px short of
        // bottom once measurements come in.
        anchoringActive.current = true;
        el2.scrollTop = el2.scrollHeight;
        const distFromBottom = el2.scrollHeight - el2.scrollTop - el2.clientHeight;
        if (distFromBottom < 4) initialScrollDone.current = true;
        requestAnimationFrame(() => {
          anchoringActive.current = false;
        });
      });
    });
  }, [chatId, items.length, layout.total]);

  // Coalesce scroll events into ≤1 updateRange per RAF. Without this, on a
  // slow CPU we may fall behind a flood of "scroll" events and pile up
  // pending RAF callbacks.
  const scrollRafRef = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    // Programmatic scroll from anchor restore should not be treated as user
    // scroll, otherwise we cancel the still-running initial auto-scroll.
    if (anchoringActive.current) {
      if (scrollRafRef.current === null) {
        scrollRafRef.current = requestAnimationFrame(() => {
          scrollRafRef.current = null;
          updateRange(false);
        });
      }
      return;
    }
    if (initialScrollDone.current === false) userScrolled.current = true;
    if (scrollRafRef.current === null) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        updateRange(true);
      });
    }
  }, [updateRange]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const children = Array.from(node.querySelectorAll<HTMLDivElement>(".vrow"));
      for (const child of children) {
        const key = child.dataset.key;
        if (!key) continue;
        if (heightsRef.current.has(key)) continue;
        const h = Math.ceil(child.getBoundingClientRect().height);
        if (h <= 0) continue;
        const prev = heightsRef.current.get(key) ?? 0;
        if (prev === 0 || Math.abs(prev - h) >= HEIGHT_DELTA_THRESHOLD_PX) {
          pendingHeights.current.set(key, h);
        }
      }
      if (!measureRaf.current && pendingHeights.current.size) {
        measureRaf.current = globalThis.setTimeout(flushMeasurements, MEASURE_FLUSH_MS) as unknown as number;
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const flushMeasurements = useCallback(() => {
    measureRaf.current = null;
    if (!pendingHeights.current.size) return;
    // Capture anchor BEFORE applying new heights — old layout still in DOM.
    captureAnchor();
    const updates: idb.HeightRow[] = [];
    for (const [key, h] of pendingHeights.current) {
      heightsRef.current.set(key, h);
      updates.push({ chatId, itemKey: key, h });
    }
    pendingHeights.current.clear();
    setMeasureVersion((v) => v + 1);
    void idb.bulkPutHeights(updates);
  }, [chatId, captureAnchor]);

  // Visual changes (font-scale, theme) invalidate measured heights — anchor +
  // clear so layout re-measures on next paint without scroll jump.
  useEffect(() => {
    const onBefore = () => {
      captureAnchor();
    };
    const onAfter = () => {
      heightsRef.current.clear();
      // Drop persisted heights for this chat too — they'll be re-measured.
      void idb.bulkPutHeights([]); // no-op safety
      setMeasureVersion((v) => v + 1);
    };
    window.addEventListener(BEFORE_VISUAL_CHANGE, onBefore);
    window.addEventListener(AFTER_VISUAL_CHANGE, onAfter);
    return () => {
      window.removeEventListener(BEFORE_VISUAL_CHANGE, onBefore);
      window.removeEventListener(AFTER_VISUAL_CHANGE, onAfter);
    };
  }, [captureAnchor]);

  // Save unflushed heights on tab unload too.
  useEffect(() => {
    const onBeforeUnload = () => {
      if (pendingHeights.current.size) {
        const updates: idb.HeightRow[] = [];
        for (const [key, h] of pendingHeights.current) {
          updates.push({ chatId, itemKey: key, h });
        }
        // Synchronous best-effort write; IDB API is async only, so rely on
        // the browser's pending-tx guarantee that puts before close usually
        // commit. Still better than dropping the data.
        void idb.bulkPutHeights(updates);
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [chatId]);

  useEffect(() => {
    return () => {
      if (measureRaf.current) {
        clearTimeout(measureRaf.current);
        flushMeasurements();
      }
    };
  }, [flushMeasurements]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setShowBottomButton(false);
  }, []);

  const visible = items.slice(range.start, range.end);
  const grouped = useMemo(() => groupConsecutiveTools(visible, range.start, itemKeys), [visible, range.start, itemKeys]);

  // Per-render-item user state: collapsed tool-groups (by their first-item
  // key) and expanded long messages (also by item key). Keyed so the state
  // survives re-renders from sync deltas; cleared on chat change because
  // these refs reset with the component.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedLong, setExpandedLong] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback(
    (key: string) => {
      captureAnchor();
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [captureAnchor],
  );

  const toggleLongMessage = useCallback(
    (key: string) => {
      captureAnchor();
      setExpandedLong((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [captureAnchor],
  );

  const isEmpty = items.length === 0;
  const isOffline = state.status.kind === "closed" || state.status.kind === "reconnecting";

  return (
    <main className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {isEmpty && (
          <div className="chat-loading">
            {isOffline
              ? "Offline. This chat hasn't been cached on this device."
              : activeWindow?.hasOlder
                ? "Loading earlier messages…"
                : "No items in this chat yet."}
          </div>
        )}
        <div
          ref={containerRef}
          className="chat-list"
          style={{ paddingTop: range.topPad, paddingBottom: range.botPad }}
        >
          {grouped.map((entry) => {
            if (entry.kind === "single") {
              const idx = entry.index;
              const key = itemKeys[idx]!;
              const isLong = entry.item.k === "t" && entry.item.txt.length > LONG_TEXT_THRESHOLD;
              const expanded = expandedLong.has(key);
              return (
                <div key={`${chatId}:${key}`} className="vrow" data-key={key}>
                  <RenderItemView
                    item={entry.item}
                    longExpanded={isLong ? expanded : undefined}
                    onToggleLong={isLong ? () => toggleLongMessage(key) : undefined}
                  />
                </div>
              );
            }
            // tool-group: wrap consecutive tu/tr items, collapsible by click on label
            const collapsed = collapsedGroups.has(entry.groupKey);
            return (
              <div key={`${chatId}:${entry.groupKey}`} className={`tool-group-wrap ${collapsed ? "collapsed" : ""}`}>
                <button
                  className="tool-group-label"
                  onClick={() => toggleGroup(entry.groupKey)}
                  aria-expanded={!collapsed}
                  title={collapsed ? "Expand tool calls" : "Collapse tool calls"}
                >
                  <span className="tool-group-caret">{collapsed ? "▶" : "▼"}</span>
                  used {entry.toolCount} tool{entry.toolCount === 1 ? "" : "s"}
                  {collapsed && (entry.firstName ? ` · ${entry.firstName}` : "")}
                </button>
                {!collapsed &&
                  entry.items.map((sub, i) => {
                    const idx = entry.startIndex + i;
                    const key = itemKeys[idx]!;
                    return (
                      <div key={`${chatId}:${key}`} className="vrow" data-key={key}>
                        <RenderItemView item={sub} />
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
      {showBottomButton && (
        <button className="bottom-btn" onClick={() => scrollToBottom("smooth")} aria-label="Scroll to bottom">
          ↓ Bottom
        </button>
      )}
      <Composer chatId={chatId} chatMeta={chatMeta?.title ?? chatId} />
    </main>
  );
}

function Composer({ chatId, chatMeta }: { chatId: string; chatMeta: string }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="composer">
      <textarea
        className="composer-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={`Reply to ${chatMeta}…`}
        rows={2}
      />
      <button className="composer-send" disabled={!draft.trim()} title="Sending is read-only in this build">
        Send
      </button>
    </div>
  );
}

type GroupEntry =
  | { kind: "single"; item: RenderItem; index: number }
  | { kind: "tool-group"; items: RenderItem[]; startIndex: number; toolCount: number; groupKey: string; firstName: string | null };

function groupConsecutiveTools(items: RenderItem[], offset: number, itemKeys: string[]): GroupEntry[] {
  const out: GroupEntry[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    if (it.k === "tu" || it.k === "tr") {
      let j = i + 1;
      const group: RenderItem[] = [it];
      while (j < items.length && (items[j]!.k === "tu" || items[j]!.k === "tr")) {
        group.push(items[j]!);
        j += 1;
      }
      const toolCount = group.filter((g) => g.k === "tu").length;
      // Stable groupKey = first item's render key. Survives re-renders / sync.
      const groupKey = `tg:${itemKeys[offset + i]!}`;
      const firstName = group.find((g) => g.k === "tu")?.name ?? null;
      out.push({ kind: "tool-group", items: group, startIndex: offset + i, toolCount, groupKey, firstName });
      i = j;
      continue;
    }
    out.push({ kind: "single", item: it, index: offset + i });
    i += 1;
  }
  return out;
}

const LONG_TEXT_THRESHOLD = 4000;

function estimateHeight(item: RenderItem): number {
  switch (item.k) {
    case "tg":
      return 32;
    case "th": {
      const lines = textLines(item.txt, 96);
      return Math.max(44, Math.min(320, 24 + lines * 18));
    }
    case "tu": {
      const inputStr = typeof item.in === "string" ? item.in : safeJson(item.in);
      const lines = textLines(inputStr, 80);
      return Math.max(60, Math.min(280, 36 + lines * 16));
    }
    case "tr": {
      const lines = textLines(item.out ?? "", 80);
      return Math.max(60, Math.min(320, 36 + lines * 16));
    }
    case "t": {
      // If the server gave us blocks, use them for a much closer estimate
      // than counting raw text length (markdown adds vertical headings, code
      // blocks, lists each with their own padding).
      if (item.blocks && item.blocks.length) {
        let h = 30; // header role label + padding
        for (const b of item.blocks) {
          switch (b.t) {
            case "p":     h += textLines(b.s, 90) * 22 + 6; break;
            case "h":     h += 28 + Math.max(0, 4 - b.lvl) * 4 + 4; break;
            case "code":  h += textLines(b.s, 80) * 18 + 16; break;
            case "ul":
            case "ol":    h += b.items.length * 22 + 6; break;
            case "quote": h += textLines(b.s, 80) * 22 + 12; break;
            case "hr":    h += 12; break;
          }
        }
        return Math.max(48, Math.min(900, h));
      }
      const lines = textLines(item.txt, 96);
      return Math.max(48, Math.min(900, 24 + lines * 22));
    }
  }
}

function textLines(s: string, charsPerLine: number): number {
  if (!s) return 1;
  const explicit = (s.match(/\n/g)?.length ?? 0) + 1;
  const wrap = Math.ceil(s.length / charsPerLine);
  return Math.max(explicit, wrap);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = Math.max(0, arr.length - 1);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((arr[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
