import { flattenPluginOptions } from "@vite-hub/internal/contributions"
import { collectOperationContributions } from "@vite-hub/internal/operations"

import { assertUniqueOperationNames } from "./console/build.ts"

import type { Plugin } from "vite"

/**
 * Fails the build when two operations share a name or a CLI command. The Console plugin checks too, but only when the
 * app sets `console`, so this runs for every app.
 */
export function operationsCheckPlugin(): Plugin {
  return {
    name: "vite-hub/operations",
    async configResolved(config) {
      await assertUniqueOperationNames(await collectOperationContributions(await flattenPluginOptions(config.plugins)))
    },
  }
}
