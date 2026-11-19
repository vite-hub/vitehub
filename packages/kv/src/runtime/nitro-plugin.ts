import { disposeKVStores } from "@vite-hub/kv"
import { hostFromNitroPreset } from "@vite-hub/internal/deployment"

import { kvInferredStoreNotice } from "../config.ts"

import type { ResolvedKVModuleOptions } from "../types.ts"

interface NitroAppLike {
  hooks: { hook(name: "close", callback: () => Promise<void>): unknown }
}

/**
 * Prints the driver that each inferred store uses in this process. A Node build of `vitehub()` prints the stores in its
 * Durability table at boot, so KV prints nothing there.
 */
async function logInferredStores(): Promise<void> {
  // SAFETY: ViteHub generates this private module from validated KV configuration.
  const { hosting, kv } = await import("#vitehub/kv/config") as { hosting: string | undefined, kv: false | ResolvedKVModuleOptions }
  if (!kv || hostFromNitroPreset(hosting) === "node") return
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
  void logInferredStores().catch((error: unknown) => console.warn("[vitehub] Could not read the KV configuration.", error))
}
