// Virtual chat view со sliding window.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RenderItem } from "../../packages/sync-v3/contracts";
import * as idb from "./idb";
import { RenderItemView } from "./render";
import { useStore, useStoreState } from "./store-hook";
import { formatBytes, formatRelative } from "./format";

const ROW_OVERSCAN = 6;
const LOAD_EDGE_PX = 720;
const MEASURE_FLUSH_MS = 80;
const HEIGHT_DELTA_THRESHOLD_PX = 6;
const NEAR_BOTTOM_PX = 200;

export function ChatView() {
  const state = useStoreState();
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
  // Re-runs while heights are still hydrating (layout.total grows as real
  // measurements replace estimates), and stops once we've reached a stable
  // bottom OR the user has scrolled manually.
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
      // Whole chat fits — nothing to scroll to.
      initialScrollDone.current = true;
      return;
    }
    el.scrollTop = layout.total;
    // Don't latch initialScrollDone yet — keep snapping to the new bottom while
    // heights hydrate (which grows layout.total). Once heights settle, the next
    // run will see no growth and we'll latch via the equal-bottom check below.
    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      const distFromBottom = scrollRef.current.scrollHeight - scrollRef.current.scrollTop - scrollRef.current.clientHeight;
      if (distFromBottom < 4) initialScrollDone.current = true;
    });
  }, [chatId, items.length, layout.total]);

  const onScroll = useCallback(() => {
    // Mark user-driven scroll so initial auto-scroll stops re-snapping.
    if (initialScrollDone.current === false) userScrolled.current = true;
    requestAnimationFrame(() => updateRange(true));
  }, [updateRange]);

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
    const updates: idb.HeightRow[] = [];
    for (const [key, h] of pendingHeights.current) {
      heightsRef.current.set(key, h);
      updates.push({ chatId, itemKey: key, h });
    }
    pendingHeights.current.clear();
    setMeasureVersion((v) => v + 1);
    void idb.bulkPutHeights(updates);
  }, [chatId]);

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
  const grouped = useMemo(() => groupConsecutiveTools(visible, range.start), [visible, range.start]);

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
              return (
                <div key={`${chatId}:${key}`} className="vrow" data-key={key}>
                  <RenderItemView item={entry.item} />
                </div>
              );
            }
            // tool-group: wrap consecutive tu/tr items
            return (
              <div key={`${chatId}:tg:${entry.startIndex}`} className="tool-group-wrap">
                <div className="tool-group-label">used {entry.toolCount} tools ▸</div>
                {entry.items.map((sub, i) => {
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
  | { kind: "tool-group"; items: RenderItem[]; startIndex: number; toolCount: number };

function groupConsecutiveTools(items: RenderItem[], offset: number): GroupEntry[] {
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
      out.push({ kind: "tool-group", items: group, startIndex: offset + i, toolCount });
      i = j;
      continue;
    }
    out.push({ kind: "single", item: it, index: offset + i });
    i += 1;
  }
  return out;
}

function estimateHeight(item: RenderItem): number {
  switch (item.k) {
    case "tg":
      return 32;
    case "th":
      return 60;
    case "tu":
    case "tr":
      return 90;
    case "t": {
      const lines = Math.ceil(item.txt.length / 96) + (item.txt.match(/\n/g)?.length ?? 0);
      return Math.max(48, Math.min(420, 24 + lines * 22));
    }
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
