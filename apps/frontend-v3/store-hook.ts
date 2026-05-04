// Singleton store + React bindings.
//
// Selects between the v3 (`view.snapshot/batch`) and v4 (`tick + query`)
// protocol stores at boot. Default is v3; flip via either:
//   • localStorage key `chatview-v3:protocol` set to "v4"
//   • URL query param `?v4` (any value, even empty)
//
// The two stores expose the same Store interface so UI components don't care.
import { useSyncExternalStore } from "react";
import { createStore as createStoreV3 } from "./views-store";
import { createStore as createStoreV4 } from "./views-store-v4";
import type { Store, StoreState } from "./views-store";

let _store: Store | null = null;

function pickProtocol(): "v3" | "v4" {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("v4")) return "v4";
  } catch {}
  try {
    if (localStorage.getItem("chatview-v3:protocol") === "v4") return "v4";
  } catch {}
  return "v3";
}

export function getStore(): Store {
  if (!_store) {
    _store = pickProtocol() === "v4" ? (createStoreV4() as unknown as Store) : createStoreV3();
  }
  return _store;
}

export function useStore(): Store {
  return getStore();
}

export function useStoreState<T = StoreState>(selector?: (s: StoreState) => T): T {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => (selector ? selector(store.getState()) : (store.getState() as unknown as T)),
    () => (selector ? selector(store.getState()) : (store.getState() as unknown as T)),
  );
}
