// Virtual chat view со sliding window.
//
// Особенности:
//   • items берутся из state.activeWindow (не из IDB напрямую — store держит окно).
//   • при подходе к верху — store.loadOlder() лезет в IDB, потом, если мало, в WS.
//   • высоты персистируются в IDB (idb.getHeightsForChat) — переключение чата не
//     приводит к remeasure storm: первый кадр уже с правильными оффсетами.
//   • один контейнерный ResizeObserver вместо одного per row.
//   • throttle measure batch — флаш не чаще раза в 30 ms.
//
// Не имеет react-markdown; рендер каждого item через RenderItemView.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RenderItem } from "../../packages/sync-v3/contracts";
import * as idb from "./idb";
import { RenderItemView } from "./render";
import { useStore, useStoreState } from "./store-hook";

const ROW_OVERSCAN = 6;
const DEFAULT_ROW_HEIGHT = 88;
const LOAD_EDGE_PX = 720;
const MEASURE_FLUSH_MS = 30;

export function ChatView() {
  const store = useStore();
  const state = useStoreState();
  const window = state.activeWindow;
  if (!state.activeChat || !window) {
    return <div className="chat-empty">Select a chat from the sidebar.</div>;
  }
  return <ActiveChat key={state.activeChat} chatId={state.activeChat} />;
}

function ActiveChat({ chatId }: { chatId: string }) {
  const store = useStore();
  const state = useStoreState();
  const window = state.activeWindow;
  const items = window?.items ?? [];

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const pendingHeights = useRef<Map<string, number>>(new Map());
  const measureRaf = useRef<number | null>(null);
  const heightsHydrated = useRef(false);

  const [measureVersion, setMeasureVersion] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number; topPad: number; botPad: number }>({
    start: 0,
    end: 0,
    topPad: 0,
    botPad: 0,
  });

  // Hydrate heights from IDB once per chat
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

  const updateRange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const bot = top + el.clientHeight;
    const start = Math.max(0, lowerBound(layout.offsets, top) - ROW_OVERSCAN);
    const end = Math.min(items.length, lowerBound(layout.offsets, bot) + ROW_OVERSCAN);
    const topPad = layout.offsets[start] ?? 0;
    const botPad = layout.total - (layout.offsets[end] ?? layout.total);
    setRange((cur) => (cur.start === start && cur.end === end && cur.topPad === topPad && cur.botPad === botPad ? cur : { start, end, topPad, botPad }));

    // Edge-loading older
    if (top < LOAD_EDGE_PX && window?.hasOlder) {
      void store.loadOlder();
    }
  }, [items.length, layout, store, window?.hasOlder]);

  useEffect(() => {
    updateRange();
  }, [updateRange]);

  const onScroll = useCallback(() => {
    requestAnimationFrame(updateRange);
  }, [updateRange]);

  // One container ResizeObserver instead of per-row.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      // Re-measure all rendered rows; cheap because there are ~range.end-range.start.
      const children = Array.from(node.querySelectorAll<HTMLDivElement>(".vrow"));
      for (const child of children) {
        const key = child.dataset.key;
        if (!key) continue;
        const h = Math.ceil(child.getBoundingClientRect().height);
        if (h <= 0) continue;
        const prev = heightsRef.current.get(key) ?? 0;
        if (Math.abs(prev - h) >= 2) pendingHeights.current.set(key, h);
      }
      if (!measureRaf.current && pendingHeights.current.size) {
        measureRaf.current = window.setTimeout(flushMeasurements, MEASURE_FLUSH_MS) as unknown as number;
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [range.start, range.end]);

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

  // Save heights on chat unmount as well, just in case.
  useEffect(() => {
    return () => {
      if (measureRaf.current) {
        clearTimeout(measureRaf.current);
        flushMeasurements();
      }
    };
  }, [flushMeasurements]);

  const visible = items.slice(range.start, range.end);

  return (
    <main className="chat-view">
      <header className="chat-head">
        <span>{chatId}</span>
        <span className="pending-bytes">
          {pendingBytesText(state.pendingBytes)}
        </span>
      </header>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div ref={containerRef} className="chat-list" style={{ paddingTop: range.topPad, paddingBottom: range.botPad }}>
          {visible.map((item, i) => {
            const idx = range.start + i;
            const key = itemKeys[idx]!;
            return (
              <div key={`${chatId}:${key}`} className="vrow" data-key={key}>
                <RenderItemView item={item} />
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}

function pendingBytesText(map: Map<string, number>): string {
  let total = 0;
  for (const v of map.values()) total += v;
  if (!total) return "synced";
  if (total < 1024) return `${total} B left`;
  if (total < 1024 * 1024) return `${Math.round(total / 1024)} KB left`;
  return `${(total / 1024 / 1024).toFixed(1)} MB left`;
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
