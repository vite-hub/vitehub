import { resolve } from "node:path"

import { installConsoleBlobScope, resolveConsoleBlob } from "../../internal.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { ConsoleBlobInspection } from "../../internal.ts"

export function installConsoleBlob(
  projectRoot: string,
  storage: BlobStorage,
  stores: readonly string[] = ["default"],
): ConsoleBlobInspection {
  const installedStores = [...new Set(stores.filter(store => store.length > 0))]
    .filter(store => store !== "default")
    .sort()
  installedStores.unshift("default")
  return installConsoleBlobScope(resolve(projectRoot), { storage, stores: installedStores })
}

export function getConsoleBlob(): ConsoleBlobInspection {
  const inspection = resolveConsoleBlob()
  if (!inspection) {
    throw new TypeError("[vitehub] Blob inspection has not been installed for this runtime.")
  }
  return inspection
}
