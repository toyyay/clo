import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { logClientEvent } from "../client-logs";
import { INTERFACE_PREFS_BEFORE_CHANGE_EVENT } from "../storage-prefs";
import { renderChatItem } from "./render-item";
import type { RenderItem, SavedScroll, ScrollAnchor, UpdateRangeOptions, VirtualRange } from "./types";

const ROW_OVERSCAN = 8;
const DEFAULT_ROW_HEIGHT = 96;
const LOAD_EDGE_PX = 720;
const SCROLL_IDLE_LOG_MS = 900;
const SCROLL_EDGE_LOG_COOLDOWN_MS = 1800;
const SCROLL_JUMP_WARN_MS = 140;
const SCROLL_JUMP_WARN_MIN_PX = 1200;
const SCROLL_ANCHOR_LOG_DELTA_PX = 24;
const SCROLL_ANCHOR_WARN_DELTA_PX = 900;
const SCROLL_MEASURE_LOG_BATCH_COUNT = 12;
const SCROLL_MEASURE_LOG_DELTA_PX = 160;
const SCROLL_MEASURE_WARN_DELTA_PX = 520;
const SCROLL_PROGRAMMATIC_EXPECT_MS = 700;
const SCROLL_PROGRAMMATIC_FAST_WINDOW_MS = 1000;
const SCROLL_PROGRAMMATIC_STEADY_WINDOW_MS = 10000;
const SCROLL_PROGRAMMATIC_FAST_COUNT = 3;
const SCROLL_PROGRAMMATIC_STEADY_COUNT = 4;
const SCROLL_PROGRAMMATIC_STEADY_INTERVAL_MS = 3000;
const SCROLL_FRAME_CANCEL_WINDOW_MS = 2000;
const SCROLL_FRAME_CANCEL_COUNT = 3;
const SCROLL_ANCHOR_CHURN_WINDOW_MS = 3000;
const SCROLL_ANCHOR_CHURN_COUNT = 3;
const SCROLL_DIRECTION_WINDOW_MS = 1800;
const SCROLL_DIRECTION_MIN_DELTA_PX = 24;
const SCROLL_DIRECTION_FLIP_COUNT = 4;
const SCROLL_ANOMALY_COOLDOWN_MS = 10000;
const SCROLL_STORAGE_PREFIX = "chatview:chat-scroll:";
const FOLLOW_BOTTOM_STORAGE_KEY = "chatview:chat-follow-bottom";

type ScrollLogLevel = "debug" | "info" | "warn" | "error";
type ScrollOrigin = "user" | "programmatic";
type ScrollAnomalyKind = "programmatic_churn" | "frame_cancel_churn" | "anchor_churn" | "direction_churn";
type ScrollDiagnosticsSnapshot = {
  itemCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
  range: VirtualRange;
  layoutTotal: number;
};
type ScrollLogState = {
  idleTimer: number | null;
  scrollStartedAt: number | null;
  lastScrollTop: number | null;
  lastScrollAt: number;
  lastIdleTop: number | null;
  lastEdgeOlderAt: number;
  lastEdgeNewerAt: number;
  expectedProgrammaticUntil: number;
  expectedProgrammaticReason: string | null;
  pendingFrameReason: string | null;
  programmaticCalls: ProgrammaticScrollCall[];
  frameCancels: FrameCancelSample[];
  anchorAdjustments: AnchorAdjustmentSample[];
  directionFlips: DirectionFlipSample[];
  lastDirection: -1 | 0 | 1;
  lastAnomalyAt: Partial<Record<ScrollAnomalyKind, number>>;
};
type ProgrammaticScrollCall = { at: number; reason: string; behavior: ScrollBehavior; beforeTop: number; targetTop: number };
type FrameCancelSample = { at: number; previousReason: string | null; nextReason: string };
type AnchorAdjustmentSample = { at: number; deltaTop: number };
type DirectionFlipSample = { at: number; from: -1 | 1; to: -1 | 1; deltaTop: number; origin: ScrollOrigin; reason: string | null };

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
  const previousEdgeKeys = useRef<{ first: string | null; last: string | null }>({ first: null, last: null });
  const resetKeyRef = useRef(resetKey);
  const followBottomRef = useRef(false);
  const diagnostics = useRef<ScrollDiagnosticsSnapshot>({
    itemCount: 0,
    hasOlder: false,
    hasNewer: false,
    range: { start: 0, end: 0, top: 0, bottom: 0 },
    layoutTotal: 0,
  });
  const scrollLog = useRef<ScrollLogState>({
    idleTimer: null,
    scrollStartedAt: null,
    lastScrollTop: null,
    lastScrollAt: 0,
    lastIdleTop: null,
    lastEdgeOlderAt: 0,
    lastEdgeNewerAt: 0,
    expectedProgrammaticUntil: 0,
    expectedProgrammaticReason: null,
    pendingFrameReason: null,
    programmaticCalls: [],
    frameCancels: [],
    anchorAdjustments: [],
    directionFlips: [],
    lastDirection: 0,
    lastAnomalyAt: {},
  });
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

  diagnostics.current = { itemCount: items.length, hasOlder, hasNewer, range, layoutTotal: layout.total };

  const logScrollDiagnostic = useCallback((level: ScrollLogLevel, event: string, message?: string | null, context?: Record<string, unknown>) => {
    const el = scrollRef.current;
    void logClientEvent(
      level,
      event,
      message ?? null,
      {
        resetKey: resetKeyRef.current,
        scroll: el ? scrollMetrics(el, diagnostics.current) : null,
        followBottom: followBottomRef.current,
        nearBottom: nearBottom.current,
        pendingBottom: pendingBottom.current,
        ...context,
      },
      ["client", "scroll"],
    ).catch(() => {});
  }, []);

  const logScrollAnomaly = useCallback((kind: ScrollAnomalyKind, message: string, context?: Record<string, unknown>) => {
    const now = performance.now();
    const state = scrollLog.current;
    const lastLoggedAt = state.lastAnomalyAt[kind] ?? 0;
    if (now - lastLoggedAt < SCROLL_ANOMALY_COOLDOWN_MS) return;
    state.lastAnomalyAt[kind] = now;
    logScrollDiagnostic("warn", `chat.scroll.anomaly.${kind}`, message, context);
  }, [logScrollDiagnostic]);

  const noteProgrammaticScroll = useCallback(
    (reason: string, behavior: ScrollBehavior, beforeTop: number, targetTop: number) => {
      const now = performance.now();
      const state = scrollLog.current;
      state.expectedProgrammaticUntil = now + SCROLL_PROGRAMMATIC_EXPECT_MS;
      state.expectedProgrammaticReason = reason;
      state.programmaticCalls = trimSamples(
        [...state.programmaticCalls, { at: now, reason, behavior, beforeTop, targetTop }],
        now - SCROLL_PROGRAMMATIC_STEADY_WINDOW_MS,
      );

      const fastCalls = state.programmaticCalls.filter((call) => now - call.at <= SCROLL_PROGRAMMATIC_FAST_WINDOW_MS);
      const steadyCalls = state.programmaticCalls.slice(-SCROLL_PROGRAMMATIC_STEADY_COUNT);
      const steadyIntervals = pairIntervals(steadyCalls);
      const steadyChurn =
        steadyCalls.length >= SCROLL_PROGRAMMATIC_STEADY_COUNT &&
        steadyIntervals.every((interval) => interval <= SCROLL_PROGRAMMATIC_STEADY_INTERVAL_MS);

      if (fastCalls.length >= SCROLL_PROGRAMMATIC_FAST_COUNT || steadyChurn) {
        logScrollAnomaly("programmatic_churn", "programmatic scroll calls are happening too often", {
          reason,
          behavior,
          fastCount: fastCalls.length,
          recentCount: state.programmaticCalls.length,
          steadyIntervalsMs: steadyIntervals.map(Math.round),
          recentReasons: state.programmaticCalls.slice(-6).map((call) => call.reason),
          beforeTop: Math.round(beforeTop),
          targetTop: Math.round(targetTop),
        });
      }
    },
    [logScrollAnomaly],
  );

  const noteFrameCancel = useCallback((nextReason: string) => {
    const now = performance.now();
    const state = scrollLog.current;
    state.frameCancels = trimSamples(
      [...state.frameCancels, { at: now, previousReason: state.pendingFrameReason, nextReason }],
      now - SCROLL_FRAME_CANCEL_WINDOW_MS,
    );
    if (state.frameCancels.length >= SCROLL_FRAME_CANCEL_COUNT) {
      logScrollAnomaly("frame_cancel_churn", "scheduled scroll frames are being replaced before they run", {
        cancelCount: state.frameCancels.length,
        nextReason,
        recentFrames: state.frameCancels.map((sample) => ({
          previousReason: sample.previousReason,
          nextReason: sample.nextReason,
          ageMs: Math.round(now - sample.at),
        })),
      });
    }
  }, [logScrollAnomaly]);

  const noteAnchorAdjustment = useCallback((deltaTop: number) => {
    const now = performance.now();
    const state = scrollLog.current;
    state.anchorAdjustments = trimSamples(
      [...state.anchorAdjustments, { at: now, deltaTop }],
      now - SCROLL_ANCHOR_CHURN_WINDOW_MS,
    );
    const totalAbsDelta = state.anchorAdjustments.reduce((total, sample) => total + Math.abs(sample.deltaTop), 0);
    const viewport = scrollRef.current?.clientHeight ?? 0;
    if (state.anchorAdjustments.length >= SCROLL_ANCHOR_CHURN_COUNT || (viewport > 0 && totalAbsDelta >= viewport * 2)) {
      logScrollAnomaly("anchor_churn", "scroll anchor is being corrected repeatedly", {
        adjustmentCount: state.anchorAdjustments.length,
        totalAbsDelta: Math.round(totalAbsDelta),
        viewport,
        recentDeltas: state.anchorAdjustments.map((sample) => Math.round(sample.deltaTop)),
      });
    }
  }, [logScrollAnomaly]);

  const noteScrollDirection = useCallback((deltaTop: number, origin: ScrollOrigin, reason: string | null) => {
    if (Math.abs(deltaTop) < SCROLL_DIRECTION_MIN_DELTA_PX) return;
    const now = performance.now();
    const state = scrollLog.current;
    const direction: -1 | 1 = deltaTop > 0 ? 1 : -1;
    if (state.lastDirection && state.lastDirection !== direction) {
      state.directionFlips = trimSamples(
        [...state.directionFlips, { at: now, from: state.lastDirection, to: direction, deltaTop, origin, reason }],
        now - SCROLL_DIRECTION_WINDOW_MS,
      );
      if (state.directionFlips.length >= SCROLL_DIRECTION_FLIP_COUNT) {
        logScrollAnomaly("direction_churn", "scroll direction is flipping rapidly", {
          flipCount: state.directionFlips.length,
          origin,
          reason,
          recentFlips: state.directionFlips.map((sample) => ({
            from: sample.from,
            to: sample.to,
            deltaTop: Math.round(sample.deltaTop),
            origin: sample.origin,
            reason: sample.reason,
            ageMs: Math.round(now - sample.at),
          })),
        });
      }
    }
    state.lastDirection = direction;
  }, [logScrollAnomaly]);

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

  const scheduleScrollIdleLog = useCallback((reason: string) => {
    const state = scrollLog.current;
    if (state.idleTimer !== null) window.clearTimeout(state.idleTimer);
    state.idleTimer = window.setTimeout(() => {
      state.idleTimer = null;
      const el = scrollRef.current;
      if (!el) return;
      const scrollTop = Math.round(el.scrollTop);
      logScrollDiagnostic("debug", "chat.scroll.idle", null, {
        reason,
        scrollDurationMs: state.scrollStartedAt === null ? null : Math.round(performance.now() - state.scrollStartedAt),
        movedSinceLastIdle: state.lastIdleTop === null ? null : scrollTop - state.lastIdleTop,
      });
      state.lastIdleTop = scrollTop;
      state.scrollStartedAt = null;
    }, SCROLL_IDLE_LOG_MS);
  }, [logScrollDiagnostic]);

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
      const now = performance.now();
      const state = scrollLog.current;
      const previousTop = state.lastScrollTop;
      const previousAt = state.lastScrollAt;
      if (state.scrollStartedAt === null) state.scrollStartedAt = now;
      state.lastScrollTop = el.scrollTop;
      state.lastScrollAt = now;
      const origin: ScrollOrigin = now <= state.expectedProgrammaticUntil ? "programmatic" : "user";
      const programmaticReason = origin === "programmatic" ? state.expectedProgrammaticReason : null;
      if (origin === "user") state.expectedProgrammaticReason = null;

      if (previousTop !== null && previousAt > 0) {
        const deltaTop = el.scrollTop - previousTop;
        const deltaMs = now - previousAt;
        noteScrollDirection(deltaTop, origin, programmaticReason);
        const jumpThreshold = Math.max(SCROLL_JUMP_WARN_MIN_PX, el.clientHeight * 1.4);
        if (deltaMs > 0 && deltaMs < SCROLL_JUMP_WARN_MS && Math.abs(deltaTop) >= jumpThreshold) {
          logScrollDiagnostic("warn", "chat.scroll.jump", "large scroll offset change", {
            deltaTop: Math.round(deltaTop),
            deltaMs: Math.round(deltaMs),
            jumpThreshold: Math.round(jumpThreshold),
            origin,
            programmaticReason,
          });
        }
      }

      scheduleScrollSave();
      const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (hasOlder && el.scrollTop < LOAD_EDGE_PX) {
        if (now - state.lastEdgeOlderAt > SCROLL_EDGE_LOG_COOLDOWN_MS) {
          state.lastEdgeOlderAt = now;
          logScrollDiagnostic("debug", "chat.scroll.edge_load_request", null, {
            direction: "older",
            edgeDistancePx: Math.round(el.scrollTop),
          });
        }
        onLoadOlder?.();
      }
      if (hasNewer && bottomGap < LOAD_EDGE_PX) {
        if (now - state.lastEdgeNewerAt > SCROLL_EDGE_LOG_COOLDOWN_MS) {
          state.lastEdgeNewerAt = now;
          logScrollDiagnostic("debug", "chat.scroll.edge_load_request", null, {
            direction: "newer",
            edgeDistancePx: Math.round(bottomGap),
          });
        }
        onLoadNewer?.();
      }
      scheduleScrollIdleLog(origin === "programmatic" ? `programmatic:${programmaticReason ?? "unknown"}` : "user_scroll");
    }
    scheduleRange({ captureAnchor: true });
  }, [hasNewer, hasOlder, logScrollDiagnostic, noteScrollDirection, onLoadNewer, onLoadOlder, scheduleRange, scheduleScrollIdleLog, scheduleScrollSave]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto", reason = "manual") => {
    const el = scrollRef.current;
    if (!el) return;
    const beforeTop = el.scrollTop;
    const beforeBottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    noteProgrammaticScroll(reason, behavior, beforeTop, targetTop);
    el.scrollTo({ top: targetTop, behavior });
    logScrollDiagnostic("debug", "chat.scroll.to_bottom", null, {
      reason,
      behavior,
      beforeTop: Math.round(beforeTop),
      beforeBottomGap: Math.round(beforeBottomGap),
      targetTop: Math.round(targetTop),
    });
    nearBottom.current = true;
    setShowBottom(false);
    scheduleRange();
  }, [logScrollDiagnostic, noteProgrammaticScroll, scheduleRange]);

  const cancelScrollFrame = useCallback((nextReason = "cancel") => {
    if (scrollRaf.current !== null) {
      noteFrameCancel(nextReason);
      window.cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = null;
      scrollLog.current.pendingFrameReason = null;
    }
  }, [noteFrameCancel]);

  const scheduleScrollFrame = useCallback(
    (callback: () => void, reason = "programmatic") => {
      cancelScrollFrame(reason);
      const expectedResetKey = resetKeyRef.current;
      scrollLog.current.pendingFrameReason = reason;
      scrollRaf.current = window.requestAnimationFrame(() => {
        scrollRaf.current = null;
        scrollLog.current.pendingFrameReason = null;
        if (resetKeyRef.current !== expectedResetKey) return;
        callback();
      });
    },
    [cancelScrollFrame],
  );

  const toggleFollowBottom = useCallback(() => {
    const next = !followBottomRef.current;
    setFollowBottom(next);
    logScrollDiagnostic("debug", "chat.scroll.follow_bottom", null, { enabled: next });
    if (next) scheduleScrollFrame(() => scrollToBottom("smooth", "follow_enabled"), "follow_enabled");
  }, [logScrollDiagnostic, scheduleScrollFrame, scrollToBottom]);

  const flushMeasurements = useCallback(() => {
    measureRaf.current = null;
    let changed = false;
    let measuredCount = 0;
    let changedCount = 0;
    let maxDelta = 0;
    let totalDelta = 0;
    for (const [key, rounded] of pendingHeights.current) {
      measuredCount += 1;
      const previous = heights.current.get(key) ?? 0;
      const delta = previous ? rounded - previous : 0;
      if (Math.abs(previous - rounded) < 2) continue;
      heights.current.set(key, rounded);
      changed = true;
      changedCount += 1;
      maxDelta = Math.max(maxDelta, Math.abs(delta));
      totalDelta += delta;
    }
    pendingHeights.current.clear();
    if (changed) {
      if (changedCount >= SCROLL_MEASURE_LOG_BATCH_COUNT || maxDelta >= SCROLL_MEASURE_LOG_DELTA_PX) {
        logScrollDiagnostic(
          maxDelta >= SCROLL_MEASURE_WARN_DELTA_PX ? "warn" : "debug",
          "chat.scroll.measure_batch",
          null,
          {
            measuredCount,
            changedCount,
            maxDelta,
            totalDelta,
          },
        );
      }
      setMeasureVersion((version) => version + 1);
    }
  }, [logScrollDiagnostic]);

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
    logScrollDiagnostic("debug", "chat.scroll.capture_anchor", null, {
      reason: "interface_change",
      heightScale,
      anchorKey: scrollAnchor.current?.key ?? null,
      anchorOffset: scrollAnchor.current ? Math.round(scrollAnchor.current.offset) : null,
    });
    saveChatScroll(resetKey, el);
    setMeasureVersion((version) => version + 1);
    scheduleRange({ captureAnchor: false });
  }, [itemKeys, items.length, layout.offsets, logScrollDiagnostic, resetKey, scheduleRange]);

  useLayoutEffect(() => {
    cancelScrollFrame("reset");
    heights.current.clear();
    pendingHeights.current.clear();
    scrollAnchor.current = null;
    nearBottom.current = true;
    if (scrollLog.current.idleTimer !== null) {
      window.clearTimeout(scrollLog.current.idleTimer);
      scrollLog.current.idleTimer = null;
    }
    scrollLog.current.scrollStartedAt = null;
    scrollLog.current.lastScrollTop = null;
    scrollLog.current.lastScrollAt = 0;
    scrollLog.current.lastIdleTop = null;
    scrollLog.current.lastEdgeOlderAt = 0;
    scrollLog.current.lastEdgeNewerAt = 0;
    scrollLog.current.expectedProgrammaticUntil = 0;
    scrollLog.current.expectedProgrammaticReason = null;
    scrollLog.current.pendingFrameReason = null;
    scrollLog.current.programmaticCalls = [];
    scrollLog.current.frameCancels = [];
    scrollLog.current.anchorAdjustments = [];
    scrollLog.current.directionFlips = [];
    scrollLog.current.lastDirection = 0;
    const saved = loadChatScroll(resetKey);
    pendingBottom.current = !saved || saved.nearBottom;
    restoredScrollKey.current = null;
    previousItemsLength.current = 0;
    previousEdgeKeys.current = { first: null, last: null };
    setRange({ start: 0, end: 0, top: 0, bottom: 0 });
    setShowBottom(false);
    setMeasureVersion((version) => version + 1);
    logScrollDiagnostic("debug", "chat.scroll.reset", null, {
      savedTop: saved?.top ?? null,
      savedNearBottom: saved?.nearBottom ?? null,
    });
  }, [cancelScrollFrame, logScrollDiagnostic, resetKey]);

  useLayoutEffect(() => {
    if (!items.length) {
      previousItemsLength.current = 0;
      previousEdgeKeys.current = { first: null, last: null };
      setRange({ start: 0, end: 0, top: 0, bottom: 0 });
      setShowBottom(false);
      return;
    }
    const wasNearBottom = nearBottom.current;
    const wasPendingBottom = pendingBottom.current;
    const previousLength = previousItemsLength.current;
    const previousFirstKey = previousEdgeKeys.current.first;
    const previousLastKey = previousEdgeKeys.current.last;
    const nextFirstKey = itemKeys[0] ?? null;
    const nextLastKey = itemKeys.at(-1) ?? null;
    const appended = items.length > previousLength;
    const prependedByKey = Boolean(previousFirstKey && nextFirstKey !== previousFirstKey && itemKeys.includes(previousFirstKey));
    const appendedByKey = Boolean(previousLastKey && nextLastKey !== previousLastKey && itemKeys.includes(previousLastKey));
    previousItemsLength.current = items.length;
    previousEdgeKeys.current = { first: nextFirstKey, last: nextLastKey };
    updateRange();
    if (previousLength !== items.length || previousFirstKey !== nextFirstKey || previousLastKey !== nextLastKey) {
      logScrollDiagnostic("debug", "chat.scroll.items_changed", null, {
        previousItemCount: previousLength,
        nextItemCount: items.length,
        deltaItems: items.length - previousLength,
        firstKeyChanged: previousFirstKey !== nextFirstKey,
        lastKeyChanged: previousLastKey !== nextLastKey,
        prependedByKey,
        appendedByKey,
        wasNearBottom,
        wasPendingBottom,
      });
    }
    const savedScroll = loadChatScroll(resetKey);
    if (savedScroll && !savedScroll.nearBottom && restoredScrollKey.current !== resetKey) {
      restoredScrollKey.current = resetKey;
      pendingBottom.current = false;
      scheduleScrollFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const nextTop = Math.min(savedScroll.top, Math.max(0, el.scrollHeight - el.clientHeight));
        noteProgrammaticScroll("restore", "auto", el.scrollTop, nextTop);
        el.scrollTop = nextTop;
        scrollAnchor.current = anchorForScroll(layout.offsets, itemKeys, nextTop, items.length);
        updateRange();
        logScrollDiagnostic("debug", "chat.scroll.restore", null, {
          savedTop: Math.round(savedScroll.top),
          appliedTop: Math.round(nextTop),
          maxTop: Math.round(Math.max(0, el.scrollHeight - el.clientHeight)),
          anchorKey: scrollAnchor.current?.key ?? null,
          anchorOffset: scrollAnchor.current ? Math.round(scrollAnchor.current.offset) : null,
        });
      }, "restore");
      return;
    }
    if (wasPendingBottom) {
      pendingBottom.current = false;
      scheduleScrollFrame(() => scrollToBottom("auto", "pending_bottom"), "pending_bottom");
    } else if (appended && followBottomRef.current) {
      scheduleScrollFrame(() => scrollToBottom("smooth", "follow_append"), "follow_append");
    } else if (appended && wasNearBottom) {
      setShowBottom(true);
    }
  }, [
    items.length,
    itemKeys,
    layout.offsets,
    layout.total,
    logScrollDiagnostic,
    noteProgrammaticScroll,
    resetKey,
    scheduleScrollFrame,
    scrollToBottom,
    updateRange,
  ]);

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
    const previousTop = el.scrollTop;
    noteProgrammaticScroll("anchor_adjust", "auto", previousTop, nextTop);
    el.scrollTop = nextTop;
    updateRange();
    const deltaTop = nextTop - previousTop;
    noteAnchorAdjustment(deltaTop);
    if (Math.abs(deltaTop) >= SCROLL_ANCHOR_LOG_DELTA_PX) {
      logScrollDiagnostic(
        Math.abs(deltaTop) >= Math.max(SCROLL_ANCHOR_WARN_DELTA_PX, el.clientHeight) ? "warn" : "debug",
        "chat.scroll.anchor_adjust",
        null,
        {
          anchorKey: anchor.key,
          anchorOffset: Math.round(anchor.offset),
          anchorIndex: index,
          previousTop: Math.round(previousTop),
          nextTop: Math.round(nextTop),
          deltaTop: Math.round(deltaTop),
        },
      );
    }
  }, [items.length, itemKeys, layout, logScrollDiagnostic, noteAnchorAdjustment, noteProgrammaticScroll, updateRange]);

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
      if (scrollLog.current.idleTimer !== null) window.clearTimeout(scrollLog.current.idleTimer);
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
          <button className="bottom-button" onClick={() => scrollToBottom("smooth", "button")} disabled={!showBottom} title="Scroll to bottom">
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
    localStorage.setItem(`${SCROLL_STORAGE_PREFIX}${resetKey}`, JSON.stringify(payload));
  } catch {
    return;
  }
}

function loadChatScroll(resetKey: string): SavedScroll | null {
  try {
    const key = `${SCROLL_STORAGE_PREFIX}${resetKey}`;
    const raw = localStorage.getItem(key) ?? sessionStorage.getItem(key);
    if (raw === null) return null;
    if (localStorage.getItem(key) === null) {
      try {
        localStorage.setItem(key, raw);
      } catch {
        // Scroll restore can still use the session value even if persistent storage is unavailable.
      }
    }
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

function trimSamples<T extends { at: number }>(samples: T[], after: number) {
  return samples.filter((sample) => sample.at >= after);
}

function pairIntervals(samples: readonly { at: number }[]) {
  const intervals: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    intervals.push(samples[index].at - samples[index - 1].at);
  }
  return intervals;
}

function scrollMetrics(el: HTMLDivElement, snapshot: ScrollDiagnosticsSnapshot) {
  const scrollTop = Math.max(0, Math.round(el.scrollTop));
  const scrollHeight = Math.max(0, Math.round(el.scrollHeight));
  const clientHeight = Math.max(0, Math.round(el.clientHeight));
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const bottomGap = Math.max(0, Math.round(scrollHeight - el.scrollTop - el.clientHeight));
  return {
    itemCount: snapshot.itemCount,
    hasOlder: snapshot.hasOlder,
    hasNewer: snapshot.hasNewer,
    range: snapshot.range,
    renderedCount: Math.max(0, snapshot.range.end - snapshot.range.start),
    layoutTotal: Math.round(snapshot.layoutTotal),
    scrollTop,
    scrollHeight,
    clientHeight,
    maxScrollTop,
    bottomGap,
    scrollRatio: maxScrollTop > 0 ? Math.round((scrollTop / maxScrollTop) * 1000) / 1000 : 1,
    nearTopEdge: scrollTop < LOAD_EDGE_PX,
    nearBottomEdge: bottomGap < LOAD_EDGE_PX,
  };
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
