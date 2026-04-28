import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { INTERFACE_PREFS_BEFORE_CHANGE_EVENT } from "../storage-prefs";
import { renderChatItem } from "./render-item";
import type { RenderItem, SavedScroll, ScrollAnchor, UpdateRangeOptions, VirtualRange } from "./types";

const ROW_OVERSCAN = 8;
const DEFAULT_ROW_HEIGHT = 96;
const LOAD_EDGE_PX = 720;
const SCROLL_STORAGE_PREFIX = "chatview:chat-scroll:";
const FOLLOW_BOTTOM_STORAGE_KEY = "chatview:chat-follow-bottom";

function estimateItemHeight(item: RenderItem) {
  if (item.kind === "tool_group") return 34;
  if (item.kind === "thinking") return 44;
  const lines = Math.ceil(item.text.length / 96) + item.text.split("\n").length - 1;
  return Math.max(44, Math.min(420, 18 + lines * 22));
}

function observedBlockSize(value: ResizeObserverSize | readonly ResizeObserverSize[] | undefined) {
  if (!value) return undefined;
  if (Array.isArray(value)) return (value as readonly ResizeObserverSize[])[0]?.blockSize;
  return (value as ResizeObserverSize).blockSize;
}

const VirtualRow = memo(function VirtualRow({
  index,
  itemKey,
  item,
  onMeasure,
}: {
  index: number;
  itemKey: string;
  item: RenderItem;
  onMeasure: (key: string, height: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const measure = (height = node.getBoundingClientRect().height) => onMeasure(itemKey, height);
    measure();
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const borderBox = entry?.borderBoxSize as ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
      const borderHeight = observedBlockSize(borderBox);
      measure(borderHeight ?? entry?.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [itemKey, onMeasure]);

  return (
    <div ref={rowRef} className="virtual-row">
      {renderChatItem(item, index)}
    </div>
  );
});

export function VirtualChat({
  items,
  resetKey,
  hasOlder = false,
  hasNewer = false,
  onLoadOlder,
  onLoadNewer,
}: {
  items: RenderItem[];
  resetKey: string;
  hasOlder?: boolean;
  hasNewer?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const nearBottom = useRef(true);
  const pendingBottom = useRef(true);
  const restoredScrollKey = useRef<string | null>(null);
  const scrollAnchor = useRef<ScrollAnchor | null>(null);
  const raf = useRef<number | null>(null);
  const scrollRaf = useRef<number | null>(null);
  const scrollSaveRaf = useRef<number | null>(null);
  const measureRaf = useRef<number | null>(null);
  const pendingHeights = useRef(new Map<string, number>());
  const pendingRangeCapture = useRef(false);
  const previousItemsLength = useRef(0);
  const resetKeyRef = useRef(resetKey);
  const followBottomRef = useRef(false);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0, top: 0, bottom: 0 });
  const [showBottom, setShowBottom] = useState(false);
  const [followBottom, setFollowBottom] = useState(readFollowBottom);

  resetKeyRef.current = resetKey;
  followBottomRef.current = followBottom;

  const itemKeys = useMemo(() => stableItemKeys(items), [items]);

  const layout = useMemo(() => {
    const offsets = new Array(items.length + 1);
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
      offsets[i] = total;
      total += heights.current.get(itemKeys[i]) ?? estimateItemHeight(items[i]) ?? DEFAULT_ROW_HEIGHT;
    }
    offsets[items.length] = total;
    return { offsets, total };
  }, [items, itemKeys, measureVersion]);

  const updateRange = useCallback((options: UpdateRangeOptions = {}) => {
    const el = scrollRef.current;
    if (!el) return;
    const viewportTop = el.scrollTop;
    const viewportBottom = viewportTop + el.clientHeight;
    const start = Math.max(0, lowerBound(layout.offsets, viewportTop) - ROW_OVERSCAN);
    const end = Math.min(items.length, lowerBound(layout.offsets, viewportBottom) + ROW_OVERSCAN);
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottom.current = bottomGap < 160;
    if (options.captureAnchor && !nearBottom.current) {
      scrollAnchor.current = anchorForScroll(layout.offsets, itemKeys, viewportTop, items.length);
    }
    const nextShowBottom = bottomGap >= 160;
    setShowBottom((current) => (current === nextShowBottom ? current : nextShowBottom));
    const nextRange = {
      start,
      end,
      top: layout.offsets[start] ?? 0,
      bottom: Math.max(0, layout.total - (layout.offsets[end] ?? layout.total)),
    };
    setRange((current) => (sameRange(current, nextRange) ? current : nextRange));
  }, [items.length, itemKeys, layout]);

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

  const scheduleScrollSave = useCallback(() => {
    if (scrollSaveRaf.current !== null) return;
    scrollSaveRaf.current = window.requestAnimationFrame(() => {
      scrollSaveRaf.current = null;
      const el = scrollRef.current;
      if (el) saveChatScroll(resetKeyRef.current, el);
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      scheduleScrollSave();
      const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (hasOlder && el.scrollTop < LOAD_EDGE_PX) onLoadOlder?.();
      if (hasNewer && bottomGap < LOAD_EDGE_PX) onLoadNewer?.();
    }
    scheduleRange({ captureAnchor: true });
  }, [hasNewer, hasOlder, onLoadNewer, onLoadOlder, scheduleRange, scheduleScrollSave]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
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

  const toggleFollowBottom = useCallback(() => {
    const next = !followBottomRef.current;
    setFollowBottom(next);
    if (next) scheduleScrollFrame(() => scrollToBottom("smooth"));
  }, [scheduleScrollFrame, scrollToBottom]);

  const flushMeasurements = useCallback(() => {
    measureRaf.current = null;
    let changed = false;
    for (const [key, rounded] of pendingHeights.current) {
      if (Math.abs((heights.current.get(key) ?? 0) - rounded) < 2) continue;
      heights.current.set(key, rounded);
      changed = true;
    }
    pendingHeights.current.clear();
    if (changed) setMeasureVersion((version) => version + 1);
  }, []);

  const onMeasure = useCallback((key: string, height: number) => {
    pendingHeights.current.set(key, Math.ceil(height));
    if (measureRaf.current !== null) return;
    measureRaf.current = window.requestAnimationFrame(flushMeasurements);
  }, [flushMeasurements]);

  const captureVisibleAnchor = useCallback((heightScale = 1) => {
    const el = scrollRef.current;
    if (!el || !items.length) return;
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottom.current = bottomGap < 160;
    if (nearBottom.current) {
      pendingBottom.current = true;
      scrollAnchor.current = null;
    } else {
      const anchor = anchorForScroll(layout.offsets, itemKeys, el.scrollTop, items.length);
      scrollAnchor.current = anchor ? { ...anchor, offset: anchor.offset * heightScale } : null;
      pendingBottom.current = false;
    }
    if (heightScale > 0 && Math.abs(heightScale - 1) > 0.01) {
      heights.current = new Map([...heights.current].map(([key, height]) => [key, Math.max(1, Math.ceil(height * heightScale))]));
    }
    saveChatScroll(resetKey, el);
    setMeasureVersion((version) => version + 1);
    scheduleRange({ captureAnchor: false });
  }, [itemKeys, items.length, layout.offsets, resetKey, scheduleRange]);

  useLayoutEffect(() => {
    cancelScrollFrame();
    heights.current.clear();
    pendingHeights.current.clear();
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
        scrollAnchor.current = anchorForScroll(layout.offsets, itemKeys, nextTop, items.length);
        updateRange();
      });
      return;
    }
    if (wasPendingBottom) {
      pendingBottom.current = false;
      scheduleScrollFrame(scrollToBottom);
    } else if (appended && followBottomRef.current) {
      scheduleScrollFrame(() => scrollToBottom("smooth"));
    } else if (appended && wasNearBottom) {
      setShowBottom(true);
    }
  }, [items.length, itemKeys, layout.total, resetKey, scheduleScrollFrame, scrollToBottom, updateRange]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = scrollAnchor.current;
    if (!el || !anchor || !items.length || nearBottom.current || pendingBottom.current) return;

    const index = itemKeys.indexOf(anchor.key);
    if (index < 0) return;
    const nextTop = clamp(
      (layout.offsets[index] ?? 0) + anchor.offset,
      0,
      Math.max(0, el.scrollHeight - el.clientHeight),
    );
    if (Math.abs(nextTop - el.scrollTop) < 1) return;
    el.scrollTop = nextTop;
    updateRange();
  }, [items.length, itemKeys, layout, updateRange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => scheduleRange());
    observer.observe(el);
    return () => observer.disconnect();
  }, [scheduleRange]);

  useEffect(() => {
    const onBeforeInterfaceChange = (event: Event) => {
      const detail = "detail" in event ? (event as CustomEvent<{ heightScale?: number }>).detail : undefined;
      captureVisibleAnchor(detail?.heightScale ?? 1);
    };
    window.addEventListener(INTERFACE_PREFS_BEFORE_CHANGE_EVENT, onBeforeInterfaceChange);
    return () => window.removeEventListener(INTERFACE_PREFS_BEFORE_CHANGE_EVENT, onBeforeInterfaceChange);
  }, [captureVisibleAnchor]);

  useEffect(() => {
    writeFollowBottom(followBottom);
  }, [followBottom]);

  useEffect(() => {
    return () => {
      if (raf.current !== null) window.cancelAnimationFrame(raf.current);
      if (scrollRaf.current !== null) window.cancelAnimationFrame(scrollRaf.current);
      if (scrollSaveRaf.current !== null) window.cancelAnimationFrame(scrollSaveRaf.current);
      if (measureRaf.current !== null) window.cancelAnimationFrame(measureRaf.current);
    };
  }, []);

  return (
    <div ref={scrollRef} className="chat-scroll" onScroll={onScroll}>
      <div className="virtual-spacer" style={{ height: range.top }} />
      <div className="items">
        {items.slice(range.start, range.end).map((item, offset) => {
          const index = range.start + offset;
          const itemKey = itemKeys[index];
          return <VirtualRow key={`${resetKey}:${itemKey}`} index={index} itemKey={itemKey} item={item} onMeasure={onMeasure} />;
        })}
      </div>
      <div className="virtual-spacer" style={{ height: range.bottom }} />
      {items.length > 0 && (
        <div className="bottom-controls">
          <button className="bottom-button" onClick={() => scrollToBottom("smooth")} disabled={!showBottom} title="Scroll to bottom">
            Bottom
          </button>
          <button
            className={`follow-button ${followBottom ? "active" : ""}`}
            onClick={toggleFollowBottom}
            aria-pressed={followBottom}
            title="Always scroll to new messages"
          >
            <span className="follow-check" aria-hidden="true">{followBottom ? "✓" : ""}</span>
            Follow
          </button>
        </div>
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

function readFollowBottom() {
  try {
    return localStorage.getItem(FOLLOW_BOTTOM_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeFollowBottom(value: boolean) {
  try {
    localStorage.setItem(FOLLOW_BOTTOM_STORAGE_KEY, value ? "true" : "false");
  } catch {
    return;
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

function anchorForScroll(offsets: number[], itemKeys: string[], scrollTop: number, itemCount: number): ScrollAnchor | null {
  if (!itemCount) return null;
  const index = clamp(upperBound(offsets, scrollTop) - 1, 0, itemCount - 1);
  return { key: itemKeys[index], offset: scrollTop - (offsets[index] ?? 0) };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sameRange(a: VirtualRange, b: VirtualRange) {
  return a.start === b.start && a.end === b.end && a.top === b.top && a.bottom === b.bottom;
}

function stableItemKeys(items: RenderItem[]) {
  return items.map((item) => itemKeyBase(item));
}

function itemKeyBase(item: RenderItem) {
  if (item.kind === "text") return `text:${item.sourceEventId}:${item.partIndex}`;
  if (item.kind === "thinking") return `thinking:${item.sourceEventId}:${item.partIndex}`;
  const head = item.uses[0] ?? item.results[0];
  const headKey = head ? `${head.sourceEventId}:${head.partIndex}` : "empty";
  return `tools:${headKey}`;
}
