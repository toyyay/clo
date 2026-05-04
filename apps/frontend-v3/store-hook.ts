// Singleton store + React bindings.
//
// v4 protocol only: the WS link carries `tick {maxRev, files?}` for liveness
// and `query` / `query.ok` for read RPCs. No predicate / snapshot / batch
// state on either side. See views-store-v4.ts for the implementation.
import { useSyncExternalStore } from "react";
import { createStore } from "./views-store-v4";
import type { Store, StoreState } from "./views-store-v4";

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
