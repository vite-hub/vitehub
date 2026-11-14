import { ownModule } from "@vite-hub/internal/build/paths"

import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Plugin } from "vite"

/** Contributes the `cache.*` operations that `vitehub cache` and the Console Cache section run. */
export function viteHubCachePlugin(): Plugin & { vitehub: { operations: readonly OperationContributionEntry[] } } {
  return {
    name: "vite-hub/cache",
    vitehub: {
      // The app imports the operations through `vite-hub`, by the path of this file.
      operations: [{ export: "cacheOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).cacheOperations, module: ownModule(import.meta.url, "cache/operations") }],
    },
  }
}
