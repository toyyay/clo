// Singleton store + React bindings.
import { useSyncExternalStore } from "react";
import { createStore, type Store, type StoreState } from "./views-store";

let _store: Store | null = null;

export function getStore(): Store {
  if (!_store) _store = createStore();
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
