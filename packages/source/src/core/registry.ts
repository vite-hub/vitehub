import { sourceNotFoundError } from "./errors.ts"
import { createSource, openSource } from "./reader.ts"

import type { RegisteredSource, Source, SourceContext, SourceName, SourceReader } from "./types.ts"

/** Imports the module of a Source file, such as `() => import("./server/sources/docs.ts")`. */
export type SourceModuleLoader = () => Promise<{ default: Source }>

interface RegisteredEntry {
  load: SourceModuleLoader
  /** The Source after the first load, so later readers reuse it. */
  source?: Promise<Source>
}

// The generated registry plugin and the app can load this module as two copies in development, so the names live on
// `globalThis`.
const registryKey: unique symbol = Symbol.for("vitehub.source.registry")

function sourceRegistry(): Map<string, RegisteredEntry> {
  const store = globalThis as typeof globalThis & { [registryKey]?: Map<string, RegisteredEntry> }
  return store[registryKey] ??= new Map()
}

/**
 * Registers the Source files by name. Each module loads when a reader of its name needs it first, so a Source costs
 * nothing at server start. The generated `server/sources/` registry plugin calls it.
 */
export function registerSourceLoaders(loaders: Record<string, SourceModuleLoader>): void {
  for (const [name, load] of Object.entries(loaders)) sourceRegistry().set(name, { load })
}

/** Registers a Source value by name. Tests call it. */
export function registerSource<const TSource extends Source>(name: string, source: TSource): TSource {
  sourceRegistry().set(name, { load: async () => ({ default: source }), source: Promise.resolve(source) })
  return source
}

export function registerSources<const TSources extends Record<string, Source>>(sources: TSources): TSources {
  for (const [name, source] of Object.entries(sources)) registerSource(name, source)
  return sources
}

export function clearSources(): void {
  sourceRegistry().clear()
}

function loadRegistered(entry: RegisteredEntry): Promise<Source> {
  if (!entry.source) {
    const loading = entry.load().then(module => module.default)
    entry.source = loading
    // A failed import, such as a syntax error during development, loads again on the next read.
    loading.catch(() => {
      if (entry.source === loading) entry.source = undefined
    })
  }
  return entry.source
}

/**
 * Opens a reader for the Source in `server/sources/<name>.ts`, or for a Source value such as `github({ repo })`.
 * The generated `.vitehub` types give each name its Source type. The file loads on the first read.
 */
export function useSource<TName extends SourceName>(name: TName, context?: Partial<SourceContext>): SourceReader<RegisteredSource<TName>>
export function useSource<const TSource extends Source>(source: TSource, context?: Partial<SourceContext>): SourceReader<TSource>
export function useSource(input: string | Source, context?: Partial<SourceContext>): SourceReader<Source> {
  if (typeof input !== "string") return createSource(input, context)
  let entry: RegisteredEntry | undefined
  return openSource(() => {
    entry ??= sourceRegistry().get(input)
    if (!entry) throw sourceNotFoundError(input)
    return loadRegistered(entry)
  }, input, { ...context, source: context?.source ?? input })
}
