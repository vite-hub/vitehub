import { hubSource as sourceHubSource } from "@vite-hub/source/vite"

import type { SourceVitePluginOptions } from "@vite-hub/source/vite"

export * from "@vite-hub/source/vite"

export function hubSource(options: SourceVitePluginOptions = {}) {
  return sourceHubSource({ importBase: "vite-hub/source", ...options })
}
