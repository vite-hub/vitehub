import { disposeKVStores } from "@vite-hub/kv"

interface NitroAppLike {
  hooks: { hook(name: "close", callback: () => Promise<void>): unknown }
}

/** Nitro plugin that releases KV connections, such as a Redis client, when the server closes, so the process can exit. */
export default function kvNitroClosePlugin(nitroApp: NitroAppLike): void {
  nitroApp.hooks.hook("close", disposeKVStores)
}
