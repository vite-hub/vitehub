import { resolve } from "node:path"

import { installConsoleKVScope, resolveConsoleKV } from "../../internal.ts"

import type { KVStorage } from "@vite-hub/kv"
import type { ConsoleKVInspection } from "../../internal.ts"

export function installConsoleKV(
  projectRoot: string,
  storage: KVStorage,
  stores: readonly string[] = ["default"],
): ConsoleKVInspection {
  const installedStores = [...new Set(stores.filter(store => store.length > 0))]
    .filter(store => store !== "default")
    .sort()
  installedStores.unshift("default")
  return installConsoleKVScope(resolve(projectRoot), { storage, stores: installedStores })
}

export function getConsoleKV(): ConsoleKVInspection {
  const inspection = resolveConsoleKV()
  if (!inspection) {
    throw new TypeError("[vitehub] KV inspection has not been installed for this runtime.")
  }
  return inspection
}
