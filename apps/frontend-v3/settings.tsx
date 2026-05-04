// Visual settings — theme and font size, persisted to localStorage and
// applied to the app via :root data attributes / CSS custom properties.

import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "auto";

const THEME_KEY = "chatview-v3:theme";
const FONT_KEY = "chatview-v3:font-scale";

const DEFAULT_THEME: Theme = "auto";
const DEFAULT_FONT_SCALE = 1.0;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.6;

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

export function readFontScale(): number {
  try {
    const v = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE) return v;
  } catch {}
  return DEFAULT_FONT_SCALE;
}
export function writeFontScale(v: number) {
  try {
    localStorage.setItem(FONT_KEY, String(v));
  } catch {}
}

/**
 * Applies theme + font-scale to the <html> element. Re-applied on every
 * change. Auto theme honors prefers-color-scheme.
 */
export function applyVisualSettings(theme: Theme, fontScale: number) {
  const root = document.documentElement;
  if (theme === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
  root.style.setProperty("--font-scale", String(fontScale));
}

export type SettingsPopoverProps = {
  theme: Theme;
  fontScale: number;
  onThemeChange: (t: Theme) => void;
  onFontScaleChange: (s: number) => void;
  onClose: () => void;
};

export function SettingsPopover({
  theme,
  fontScale,
  onThemeChange,
  onFontScaleChange,
  onClose,
}: SettingsPopoverProps) {
  // Outside click closes.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".settings-pop") || t.closest(".settings-button")) return;
      onClose();
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [onClose]);

  return (
    <div className="settings-pop">
      <div className="settings-section">
        <div className="settings-label">Theme</div>
        <div className="settings-row">
          {(["light", "auto", "dark"] as const).map((t) => (
            <button
              key={t}
              className={`settings-chip ${theme === t ? "active" : ""}`}
              onClick={() => onThemeChange(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-label">Font size</div>
        <div className="settings-row">
          <button
            className="settings-chip"
            onClick={() => onFontScaleChange(Math.max(MIN_SCALE, Number((fontScale - 0.1).toFixed(2))))}
            aria-label="Smaller"
          >
            A−
          </button>
          <span className="settings-value">{Math.round(fontScale * 100)}%</span>
          <button
            className="settings-chip"
            onClick={() => onFontScaleChange(Math.min(MAX_SCALE, Number((fontScale + 0.1).toFixed(2))))}
            aria-label="Larger"
          >
            A+
          </button>
          <button
            className="settings-chip settings-chip-reset"
            onClick={() => onFontScaleChange(DEFAULT_FONT_SCALE)}
            aria-label="Reset"
          >
            ↺
          </button>
        </div>
      </div>
    </div>
  );
}

export function useVisualSettings() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [fontScale, setFontScale] = useState<number>(() => readFontScale());

  useEffect(() => {
    applyVisualSettings(theme, fontScale);
  }, [theme, fontScale]);

  // Auto: re-apply when system color scheme changes.
  useEffect(() => {
    if (theme !== "auto" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyVisualSettings(theme, fontScale);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme, fontScale]);

  const set = (t: Theme) => {
    writeTheme(t);
    setTheme(t);
  };
  const setScale = (s: number) => {
    writeFontScale(s);
    setFontScale(s);
  };

  return { theme, fontScale, setTheme: set, setFontScale: setScale };
}
