// Visual settings — theme + rich interface prefs (UI scale, chat scale,
// density, line-height, paragraph spacing, line width, display mode).
//
// Storage:
//   chatview-v3:theme            -> "light" | "dark" | "auto"
//   chatview-v3:interface-prefs  -> JSON of InterfacePrefs
//   chatview-v3:font-scale       -> legacy single number (kept for migration)
//
// CSS contract — applied on :root by applyVisualSettings():
//   data-theme        = "light" | "dark" | absent (auto)
//   data-display      = "desktop" | "eink" (resolved from auto + matchMedia)
//   --font-scale      = legacy alias, equals chatScale (so old rules keep working)
//   --ui-scale        = scales topbar/sidebar text
//   --chat-scale      = scales chat content text
//   --ui-density      = multiplier for paddings/min-heights
//   --chat-line-height
//   --chat-paragraph-spacing  (px)
//   --chat-width      (px, capped to viewport at render-time)
//
// Events fired around every apply so the chat virtual scroll can pin its
// scroll anchor across font-size changes.

import { useEffect, useState } from "react";

// ---------- types ----------

export type Theme = "light" | "dark" | "auto";
export type DisplayMode = "auto" | "desktop" | "eink";

export type InterfacePrefs = {
  displayMode: DisplayMode;
  uiScale: number;
  chatScale: number;
  density: number;
  lineHeight: number;
  paragraphSpacing: number;
  chatWidth: number;
};

export const DEFAULT_INTERFACE_PREFS: InterfacePrefs = {
  displayMode: "auto",
  uiScale: 1,
  chatScale: 1,
  density: 1,
  lineHeight: 1.5,
  paragraphSpacing: 10,
  chatWidth: 920,
};

export const INTERFACE_PREF_LIMITS = {
  uiScale: { min: 0.72, max: 1.22, step: 0.01 },
  chatScale: { min: 0.72, max: 1.36, step: 0.01 },
  density: { min: 0.62, max: 1.22, step: 0.01 },
  lineHeight: { min: 1.12, max: 1.72, step: 0.01 },
  paragraphSpacing: { min: 0, max: 18, step: 1 },
  chatWidth: { min: 320, max: 1120, step: 20 },
} as const;

export const EINK_CHAT_WIDTH_DEFAULT = 760;
export const EINK_CHAT_WIDTH_MAX = 860;

// ---------- storage ----------

const THEME_KEY = "chatview-v3:theme";
const PREFS_KEY = "chatview-v3:interface-prefs";
const LEGACY_FONT_KEY = "chatview-v3:font-scale";

const DEFAULT_THEME: Theme = "auto";

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {}
  return DEFAULT_THEME;
}
export function writeTheme(v: Theme) {
  try {
    localStorage.setItem(THEME_KEY, v);
  } catch {}
}

export function readInterfacePrefs(): InterfacePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return clampInterfacePrefs(JSON.parse(raw) as Partial<InterfacePrefs>);
    // Migration: pick up the legacy single-number font-scale and treat it as chatScale.
    const legacy = Number(localStorage.getItem(LEGACY_FONT_KEY));
    if (Number.isFinite(legacy) && legacy > 0) {
      return clampInterfacePrefs({ ...DEFAULT_INTERFACE_PREFS, chatScale: legacy, uiScale: legacy });
    }
  } catch {}
  return DEFAULT_INTERFACE_PREFS;
}

export function writeInterfacePrefs(value: InterfacePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(clampInterfacePrefs(value)));
  } catch {}
}

// ---------- legacy shims (some call sites still import these) ----------

export function readFontScale(): number {
  return readInterfacePrefs().chatScale;
}
export function writeFontScale(v: number) {
  const prefs = readInterfacePrefs();
  writeInterfacePrefs({ ...prefs, chatScale: v });
}

// ---------- apply ----------

export const BEFORE_VISUAL_CHANGE = "chatview-v3:before-visual-change";
export const AFTER_VISUAL_CHANGE = "chatview-v3:after-visual-change";

export function detectAutoDisplayMode(): Exclude<DisplayMode, "auto"> {
  if (typeof window === "undefined" || !("matchMedia" in window)) return "desktop";
  return window.matchMedia("(monochrome), (prefers-contrast: more), (update: slow)").matches ? "eink" : "desktop";
}

export function effectiveChatWidth(prefs: InterfacePrefs, displayMode: Exclude<DisplayMode, "auto">) {
  if (displayMode !== "eink") return prefs.chatWidth;
  if (prefs.chatWidth === DEFAULT_INTERFACE_PREFS.chatWidth) return EINK_CHAT_WIDTH_DEFAULT;
  return Math.min(EINK_CHAT_WIDTH_MAX, prefs.chatWidth);
}

/** Three-arg overload: theme + full prefs object. */
export function applyVisualSettings(theme: Theme, prefs: InterfacePrefs): void;
/** Legacy two-arg overload kept for app.tsx synchronous boot. */
export function applyVisualSettings(theme: Theme, fontScale: number): void;
export function applyVisualSettings(theme: Theme, prefsOrScale: InterfacePrefs | number) {
  const prefs =
    typeof prefsOrScale === "number"
      ? { ...readInterfacePrefs(), chatScale: prefsOrScale }
      : clampInterfacePrefs(prefsOrScale);

  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(BEFORE_VISUAL_CHANGE));
  } catch {}

  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  const displayResolved = prefs.displayMode === "auto" ? detectAutoDisplayMode() : prefs.displayMode;
  root.setAttribute("data-display", displayResolved);

  // Legacy alias — keeps every old `calc(13px * var(--font-scale))` rule alive.
  // It maps to UI scale because most old rules style topbar/sidebar; chat
  // content rules below use --chat-scale explicitly.
  root.style.setProperty("--font-scale", String(prefs.uiScale));
  root.style.setProperty("--ui-scale", String(prefs.uiScale));
  root.style.setProperty("--chat-scale", String(prefs.chatScale));
  root.style.setProperty("--ui-density", String(prefs.density));
  root.style.setProperty("--chat-line-height", prefs.lineHeight.toFixed(3));
  root.style.setProperty("--chat-paragraph-spacing", `${Math.round(prefs.paragraphSpacing)}px`);
  root.style.setProperty("--chat-width", `${effectiveChatWidth(prefs, displayResolved)}px`);

  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(AFTER_VISUAL_CHANGE));
  } catch {}
}

export function clampInterfacePrefs(value: Partial<InterfacePrefs>): InterfacePrefs {
  return {
    displayMode: clampDisplayMode(value.displayMode),
    uiScale: clampNumber(value.uiScale, INTERFACE_PREF_LIMITS.uiScale, DEFAULT_INTERFACE_PREFS.uiScale),
    chatScale: clampNumber(value.chatScale, INTERFACE_PREF_LIMITS.chatScale, DEFAULT_INTERFACE_PREFS.chatScale),
    density: clampNumber(value.density, INTERFACE_PREF_LIMITS.density, DEFAULT_INTERFACE_PREFS.density),
    lineHeight: clampNumber(value.lineHeight, INTERFACE_PREF_LIMITS.lineHeight, DEFAULT_INTERFACE_PREFS.lineHeight),
    paragraphSpacing: Math.round(
      clampNumber(value.paragraphSpacing, INTERFACE_PREF_LIMITS.paragraphSpacing, DEFAULT_INTERFACE_PREFS.paragraphSpacing),
    ),
    chatWidth: Math.round(clampNumber(value.chatWidth, INTERFACE_PREF_LIMITS.chatWidth, DEFAULT_INTERFACE_PREFS.chatWidth)),
  };
}

function clampNumber(value: unknown, lim: { min: number; max: number }, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(lim.max, Math.max(lim.min, n));
}

function clampDisplayMode(v: unknown): DisplayMode {
  return v === "desktop" || v === "eink" || v === "auto" ? v : DEFAULT_INTERFACE_PREFS.displayMode;
}

// ---------- React hook ----------

export function useVisualSettings() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [prefs, setPrefs] = useState<InterfacePrefs>(() => readInterfacePrefs());

  useEffect(() => {
    applyVisualSettings(theme, prefs);
  }, [theme, prefs]);

  // Auto theme + auto display-mode: react to system colour-scheme changes.
  useEffect(() => {
    const reapply = () => applyVisualSettings(theme, prefs);
    const list: MediaQueryList[] = [];
    if (theme === "auto" && typeof window.matchMedia === "function") {
      list.push(window.matchMedia("(prefers-color-scheme: dark)"));
    }
    if (prefs.displayMode === "auto" && typeof window.matchMedia === "function") {
      list.push(window.matchMedia("(monochrome), (prefers-contrast: more), (update: slow)"));
    }
    list.forEach((mq) => mq.addEventListener("change", reapply));
    return () => list.forEach((mq) => mq.removeEventListener("change", reapply));
  }, [theme, prefs]);

  const setThemeAndPersist = (t: Theme) => {
    writeTheme(t);
    setTheme(t);
  };

  const updatePrefs = (patch: Partial<InterfacePrefs>) => {
    setPrefs((cur) => {
      const next = clampInterfacePrefs({ ...cur, ...patch });
      writeInterfacePrefs(next);
      return next;
    });
  };

  const resetPrefs = () => {
    writeInterfacePrefs(DEFAULT_INTERFACE_PREFS);
    setPrefs(DEFAULT_INTERFACE_PREFS);
  };

  return { theme, prefs, setTheme: setThemeAndPersist, updatePrefs, resetPrefs };
}

// ---------- Aa popover ----------

export type InterfacePrefsPopoverProps = {
  open: boolean;
  theme: Theme;
  prefs: InterfacePrefs;
  onToggle: () => void;
  onClose: () => void;
  onThemeChange: (t: Theme) => void;
  onChange: (patch: Partial<InterfacePrefs>) => void;
  onReset: () => void;
};

export function InterfacePrefsPopover({
  open,
  theme,
  prefs,
  onToggle,
  onClose,
  onThemeChange,
  onChange,
  onReset,
}: InterfacePrefsPopoverProps) {
  return (
    <div className="prefs-wrap">
      <button
        className={`icon-btn settings-button ${open ? "active" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
        title="Display settings"
      >
        Aa
      </button>
      {open && (
        <>
          <button className="prefs-backdrop" aria-label="Close display settings" onClick={onClose} />
          <section className="prefs-popover" role="dialog" aria-label="Display settings">
            <div className="prefs-head">
              <h2>Aa</h2>
              <DisplayModeControl value={prefs.displayMode} onChange={(displayMode) => onChange({ displayMode })} />
              <button className="icon-btn prefs-reset" onClick={onReset}>
                Reset
              </button>
            </div>
            <div className="prefs-theme-row">
              <span className="prefs-theme-label">Theme</span>
              {(["light", "auto", "dark"] as const).map((t) => (
                <button
                  key={t}
                  className={`prefs-chip ${theme === t ? "active" : ""}`}
                  onClick={() => onThemeChange(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <RangeControl
              label="Interface"
              value={prefs.uiScale}
              limit={INTERFACE_PREF_LIMITS.uiScale}
              display={`${Math.round(prefs.uiScale * 100)}%`}
              onChange={(uiScale) => onChange({ uiScale })}
            />
            <RangeControl
              label="Chat text"
              value={prefs.chatScale}
              limit={INTERFACE_PREF_LIMITS.chatScale}
              display={`${Math.round(prefs.chatScale * 100)}%`}
              onChange={(chatScale) => onChange({ chatScale })}
            />
            <RangeControl
              label="Spacing"
              value={prefs.density}
              limit={INTERFACE_PREF_LIMITS.density}
              display={`${Math.round(prefs.density * 100)}%`}
              onChange={(density) => onChange({ density })}
            />
            <RangeControl
              label="Line spacing"
              value={prefs.lineHeight}
              limit={INTERFACE_PREF_LIMITS.lineHeight}
              display={`${prefs.lineHeight.toFixed(2)}x`}
              onChange={(lineHeight) => onChange({ lineHeight })}
            />
            <RangeControl
              label="Paragraphs"
              value={prefs.paragraphSpacing}
              limit={INTERFACE_PREF_LIMITS.paragraphSpacing}
              display={`${Math.round(prefs.paragraphSpacing)}px`}
              onChange={(paragraphSpacing) => onChange({ paragraphSpacing })}
            />
            <RangeControl
              label="Line width"
              value={prefs.chatWidth}
              limit={INTERFACE_PREF_LIMITS.chatWidth}
              display={`${prefs.chatWidth}px`}
              onChange={(chatWidth) => onChange({ chatWidth })}
            />
          </section>
        </>
      )}
    </div>
  );
}

function DisplayModeControl({ value, onChange }: { value: DisplayMode; onChange: (value: DisplayMode) => void }) {
  const options: Array<{ value: DisplayMode; label: string }> = [
    { value: "auto", label: "Auto" },
    { value: "desktop", label: "Desktop" },
    { value: "eink", label: "E-ink" },
  ];
  return (
    <div className="prefs-mode" role="group" aria-label="Display mode">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RangeControl({
  label,
  value,
  limit,
  display,
  onChange,
}: {
  label: string;
  value: number;
  limit: { min: number; max: number; step: number };
  display: string;
  onChange: (value: number) => void;
}) {
  const stepValue = (direction: -1 | 1) => {
    const raw = value + limit.step * direction;
    const clamped = Math.min(limit.max, Math.max(limit.min, raw));
    const rounded = Math.round(clamped / limit.step) * limit.step;
    onChange(Number(rounded.toFixed(limit.step < 1 ? 4 : 0)));
  };
  return (
    <div className="prefs-range">
      <div className="prefs-range-head">
        <b>{label}</b>
        <output>{display}</output>
      </div>
      <div className="range-stepper">
        <button type="button" className="range-step-button" onClick={() => stepValue(-1)} aria-label={`Decrease ${label}`}>
          −
        </button>
        <input
          aria-label={label}
          type="range"
          min={limit.min}
          max={limit.max}
          step={limit.step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <button type="button" className="range-step-button" onClick={() => stepValue(1)} aria-label={`Increase ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}
