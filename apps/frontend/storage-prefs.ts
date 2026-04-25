export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 680;

export const SIDEBAR_WIDTH_STORAGE_KEY = "chatview:sidebar-width";
export const GROUP_BY_PROJECT_STORAGE_KEY = "chatview:group-by-project";
export const PROVIDER_FILTER_STORAGE_KEY = "chatview:provider-filter";
export const DEVICE_FILTER_STORAGE_KEY = "chatview:device-filter";

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
