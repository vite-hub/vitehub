import { hubSource as sourceHubSource } from "@vite-hub/source/vite"

import { viteHubTypesPlugin } from "../internal/types.ts"

import type { SourceVitePluginOptions } from "@vite-hub/source/vite"
import type { Plugin } from "vite"

export * from "@vite-hub/source/vite"

export function hubSource(options: SourceVitePluginOptions = {}): Plugin[] {
  return [
    sourceHubSource({ importBase: "vite-hub/source", ...options }),
    viteHubTypesPlugin(),
  ]
}
