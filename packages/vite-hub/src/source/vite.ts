import { hubSource as sourceHubSource } from "@vite-hub/source/vite"

import { viteHubTypesPlugin } from "../internal/types.ts"

import type { SourceVitePluginOptions } from "@vite-hub/source/vite"
import type { Plugin } from "vite"

export * from "@vite-hub/source/vite"

export function hubSource(options: SourceVitePluginOptions = {}): Plugin[] {
  const source = sourceHubSource({ importBase: "vite-hub/source", ...options })
  return [
    source,
    viteHubTypesPlugin({ prepareSources: source.api.prepareSources }),
  ]
}
