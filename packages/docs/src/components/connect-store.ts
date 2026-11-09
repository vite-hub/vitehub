import { type Connect, type ConnectCredentials, type ConnectProviderName, connectEnv } from "@vite-hub/web-container/connect";
import { computed, type ComputedRef, type Ref, readonly, ref } from "vue";

export interface UseConnectStoreOptions {
  /**
   * Where tokens are kept. `session` forgets them when the tab closes. `memory` forgets them on reload.
   * @default "session"
   */
  storage?: "session" | "local" | "memory";
  /** @default "vitehub:connect" */
  key?: string;
}

export interface ConnectStore {
  credentials: Readonly<Ref<ConnectCredentials>>;
  set: (provider: ConnectProviderName, token: string) => void;
  remove: (provider: ConnectProviderName) => void;
  clear: () => void;
  /** The `env` of a workspace run, such as `useWebContainer({ env: store.env(connect) })`. */
  env: (connect: Connect) => ComputedRef<Record<string, string>>;
}

function browserStorage(kind: "session" | "local" | "memory"): Storage | undefined {
  if (kind === "memory" || typeof window === "undefined") return undefined;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  }
  catch {
    // Storage throws when the browser blocks it, for example in some private modes. Tokens then stay in memory.
    return undefined;
  }
}

function read(storage: Storage | undefined, key: string): ConnectCredentials {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  catch {
    return {};
  }
}

/** A small token store for `ConnectPanel`. Tokens stay in this browser and never go to a server. */
export function useConnectStore(options: UseConnectStoreOptions = {}): ConnectStore {
  const key = options.key ?? "vitehub:connect";
  const storage = browserStorage(options.storage ?? "session");
  const credentials = ref<ConnectCredentials>(read(storage, key));

  function save(next: ConnectCredentials) {
    credentials.value = next;
    if (!storage) return;
    try {
      if (Object.keys(next).length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(next));
    }
    catch {
      // The in-memory credentials still work when persistence is blocked or full.
    }
  }

  return {
    credentials: readonly(credentials),
    set: (provider, token) => save({ ...credentials.value, [provider]: token }),
    remove(provider) {
      const { [provider]: _removed, ...rest } = credentials.value;
      save(rest);
    },
    clear: () => save({}),
    env: connect => computed(() => connectEnv(connect, credentials.value)),
  };
}
