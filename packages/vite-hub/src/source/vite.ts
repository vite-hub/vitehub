import {
  hubSource as sourceHubSource,
  prepareSourceGeneration as prepareOwnerSourceGeneration,
} from "@vite-hub/source/vite"

import { viteHubTypesPlugin } from "../internal/types.ts"

import type {
  GeneratedSourceHandler,
  SourceGenerationOptions,
  SourceVitePluginOptions,
} from "@vite-hub/source/vite"
import type { Plugin } from "vite"

export {
  mergeGeneratedSourceNitroConfig,
  toRuntimeModuleSpecifier,
  toTypeModuleSpecifier,
} from "@vite-hub/source/vite"
export type {
  GeneratedSourceHandler,
  GeneratedSourceHandlersListener,
  GeneratedSourceHandlersListenerOptions,
  SourceGenerationOptions,
  SourceVitePluginOptions,
} from "@vite-hub/source/vite"

export function prepareSourceGeneration(options: SourceGenerationOptions): Promise<GeneratedSourceHandler[]> {
  return prepareOwnerSourceGeneration({ ...options, importBase: options.importBase ?? "vite-hub/source" })
}

export function hubSource(options: SourceVitePluginOptions = {}): Plugin[] {
  const source = sourceHubSource({ ...options, importBase: options.importBase ?? "vite-hub/source" })
  return [
    source,
    viteHubTypesPlugin({ prepareSources: source.api.prepareSources }),
  ]
}
