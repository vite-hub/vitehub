import { sourceNotFoundError } from "./errors.ts"
import { createSource } from "./reader.ts"

import type { RegisteredSource, Source, SourceContext, SourceName, SourceReader } from "./types.ts"

// The generated registry plugin and the app can load this module as two copies in development, so the names live on
// `globalThis`.
const registryKey: unique symbol = Symbol.for("vitehub.source.registry")

function sourceRegistry(): Map<string, Source> {
  const store = globalThis as typeof globalThis & { [registryKey]?: Map<string, Source> }
  return store[registryKey] ??= new Map()
}

/** Registers a Source by name. The generated `server/sources/` registry and tests call it. */
export function registerSource<const TSource extends Source>(name: string, source: TSource): TSource {
  sourceRegistry().set(name, source)
  return source
}

export function registerSources<const TSources extends Record<string, Source>>(sources: TSources): TSources {
  for (const [name, source] of Object.entries(sources)) registerSource(name, source)
  return sources
}

export function clearSources(): void {
  sourceRegistry().clear()
}

/**
 * Opens a reader for the Source in `server/sources/<name>.ts`, or for a Source value such as `github({ repo })`.
 * The generated `.vitehub` types give each name its Source type.
 */
export function useSource<TName extends SourceName>(name: TName, context?: Partial<SourceContext>): SourceReader<RegisteredSource<TName>>
export function useSource<const TSource extends Source>(source: TSource, context?: Partial<SourceContext>): SourceReader<TSource>
export function useSource(input: string | Source, context?: Partial<SourceContext>): SourceReader<Source> {
  if (typeof input !== "string") return createSource(input, context)
  const source = sourceRegistry().get(input)
  if (!source) throw sourceNotFoundError(input)
  return createSource(source, { ...context, source: context?.source ?? input })
}
