import {
  hubSource as sourceHubSource,
  prepareSourceGeneration as prepareOwnerSourceGeneration,
} from "@vite-hub/source/vite"

import { viteHubTypesPlugin } from "../internal/types.ts"

import type { SourceGenerationOptions, SourceVitePluginOptions } from "@vite-hub/source/vite"
import type { Plugin } from "vite"

export {
  mergeGeneratedSourceNitroConfig,
  toRuntimeModuleSpecifier,
  toTypeModuleSpecifier,
} from "@vite-hub/source/vite"
export type {
  GeneratedSourceHandler,
  SourceGenerationOptions,
  SourceVitePluginOptions,
} from "@vite-hub/source/vite"

export function prepareSourceGeneration(options: SourceGenerationOptions) {
  return prepareOwnerSourceGeneration({ importBase: "vite-hub/source", ...options })
}

export function hubSource(options: SourceVitePluginOptions = {}): Plugin[] {
  const source = sourceHubSource({ importBase: "vite-hub/source", ...options })
  return [
    source,
    viteHubTypesPlugin({ prepareSources: source.api.prepareSources }),
  ]
}
