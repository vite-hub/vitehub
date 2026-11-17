import { logFailure } from "@vite-hub/internal/runtime/request-log"
import { disposeKVStores } from "@vite-hub/kv"

import { kvInferredStoreNotice } from "../config.ts"

import type { ResolvedKVModuleOptions } from "../types.ts"

interface NitroAppLike {
  hooks: { hook(name: "close", callback: () => Promise<void>): unknown }
}

/** Prints the driver that each inferred store uses in this process. */
async function logInferredStores(): Promise<void> {
  // SAFETY: ViteHub generates this private module from validated KV configuration.
  const { kv } = await import("#vitehub/kv/config") as { kv: false | ResolvedKVModuleOptions }
  if (!kv) return
  for (const [name, store] of Object.entries(kv.stores ?? { default: kv.store })) {
    const notice = kvInferredStoreNotice(name, store)
    if (notice) console.info(notice)
  }
}

/**
 * Nitro plugin of KV for Redis connections and inferred-store boot notices. On close it releases KV connections,
 * so the process can exit.
 */
export default function kvNitroPlugin(nitroApp: NitroAppLike): void {
  nitroApp.hooks.hook("close", disposeKVStores)
  void logInferredStores().catch((error: unknown) => {
    logFailure({ field: "kv", fields: { op: "read-config" }, message: "KV could not read its configuration", error }, () => console.warn("[vitehub] Could not read the KV configuration.", error))
  })
}
