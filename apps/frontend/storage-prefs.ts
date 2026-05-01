export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 680;

export const SIDEBAR_WIDTH_STORAGE_KEY = "chatview:sidebar-width";
export const GROUP_BY_PROJECT_STORAGE_KEY = "chatview:group-by-project";
export const PROVIDER_FILTER_STORAGE_KEY = "chatview:provider-filter";
export const DEVICE_FILTER_STORAGE_KEY = "chatview:device-filter";
export const PROJECT_FILTER_STORAGE_KEY = "chatview:project-filter";
export const SIDEBAR_TREE_STORAGE_KEY = "chatview:sidebar-tree";
export const INTERFACE_PREFS_STORAGE_KEY = "chatview:interface-prefs";
export const INTERFACE_PREFS_BEFORE_CHANGE_EVENT = "chatview:before-interface-prefs-change";
export const RETENTION_DAYS_STORAGE_KEY = "chatview:retention-days";
export const DEFAULT_RETENTION_DAYS = 15;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 180;

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

export const EINK_CHAT_WIDTH_DEFAULT = 760;
export const EINK_CHAT_WIDTH_MAX = 860;
export const INTERFACE_PREF_LIMITS = {
  uiScale: { min: 0.72, max: 1.22, step: 0.01 },
  chatScale: { min: 0.72, max: 1.36, step: 0.01 },
  density: { min: 0.62, max: 1.22, step: 0.01 },
  lineHeight: { min: 1.12, max: 1.72, step: 0.01 },
  paragraphSpacing: { min: 0, max: 18, step: 1 },
  chatWidth: { min: 320, max: 1120, step: 20 },
} as const;

export function readLocalStorageString(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeLocalStorageValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

export function readLocalStorageBoolean(key: string, fallback: boolean) {
  const value = readLocalStorageString(key, fallback ? "true" : "false");
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function clampInterfacePrefs(value: Partial<InterfacePrefs>): InterfacePrefs {
  return {
    displayMode: clampDisplayMode(value.displayMode),
    uiScale: clampNumber(value.uiScale, INTERFACE_PREF_LIMITS.uiScale.min, INTERFACE_PREF_LIMITS.uiScale.max, DEFAULT_INTERFACE_PREFS.uiScale),
    chatScale: clampNumber(value.chatScale, INTERFACE_PREF_LIMITS.chatScale.min, INTERFACE_PREF_LIMITS.chatScale.max, DEFAULT_INTERFACE_PREFS.chatScale),
    density: clampNumber(value.density, INTERFACE_PREF_LIMITS.density.min, INTERFACE_PREF_LIMITS.density.max, DEFAULT_INTERFACE_PREFS.density),
    lineHeight: clampNumber(
      value.lineHeight,
      INTERFACE_PREF_LIMITS.lineHeight.min,
      INTERFACE_PREF_LIMITS.lineHeight.max,
      DEFAULT_INTERFACE_PREFS.lineHeight,
    ),
    paragraphSpacing: Math.round(
      clampNumber(
        value.paragraphSpacing,
        INTERFACE_PREF_LIMITS.paragraphSpacing.min,
        INTERFACE_PREF_LIMITS.paragraphSpacing.max,
        DEFAULT_INTERFACE_PREFS.paragraphSpacing,
      ),
    ),
    chatWidth: Math.round(
      clampNumber(value.chatWidth, INTERFACE_PREF_LIMITS.chatWidth.min, INTERFACE_PREF_LIMITS.chatWidth.max, DEFAULT_INTERFACE_PREFS.chatWidth),
    ),
  };
}

export function readInterfacePrefs() {
  try {
    const raw = localStorage.getItem(INTERFACE_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_INTERFACE_PREFS;
    return clampInterfacePrefs(JSON.parse(raw) as Partial<InterfacePrefs>);
  } catch {
    return DEFAULT_INTERFACE_PREFS;
  }
}

export function writeInterfacePrefs(value: InterfacePrefs) {
  writeLocalStorageValue(INTERFACE_PREFS_STORAGE_KEY, JSON.stringify(clampInterfacePrefs(value)));
}

export function detectAutoDisplayMode(): Exclude<DisplayMode, "auto"> {
  if (typeof window === "undefined" || !("matchMedia" in window)) return "desktop";
  return window.matchMedia("(monochrome), (prefers-contrast: more), (update: slow)").matches ? "eink" : "desktop";
}

export function effectiveChatWidth(prefs: InterfacePrefs, displayMode: Exclude<DisplayMode, "auto">) {
  if (displayMode !== "eink") return prefs.chatWidth;
  if (prefs.chatWidth === DEFAULT_INTERFACE_PREFS.chatWidth) return EINK_CHAT_WIDTH_DEFAULT;
  return Math.min(EINK_CHAT_WIDTH_MAX, prefs.chatWidth);
}

export function sidebarWidthLimit() {
  const viewportLimit = typeof window === "undefined" ? MAX_SIDEBAR_WIDTH : Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 28);
  return Math.min(MAX_SIDEBAR_WIDTH, viewportLimit);
}

export function clampSidebarWidth(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.round(Math.min(sidebarWidthLimit(), Math.max(MIN_SIDEBAR_WIDTH, value)));
}

export function readSidebarWidth() {
  const value = Number(readLocalStorageString(SIDEBAR_WIDTH_STORAGE_KEY, String(DEFAULT_SIDEBAR_WIDTH)));
  return clampSidebarWidth(value);
}

export function clampRetentionDays(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_RETENTION_DAYS;
  return Math.round(Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, number)));
}

export function readRetentionDays() {
  return clampRetentionDays(readLocalStorageString(RETENTION_DAYS_STORAGE_KEY, String(DEFAULT_RETENTION_DAYS)));
}

export function writeRetentionDays(value: number) {
  writeLocalStorageValue(RETENTION_DAYS_STORAGE_KEY, String(clampRetentionDays(value)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampDisplayMode(value: unknown): DisplayMode {
  return value === "desktop" || value === "eink" || value === "auto" ? value : DEFAULT_INTERFACE_PREFS.displayMode;
}
