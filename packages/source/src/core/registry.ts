import { sourceNotFoundError } from "./errors.ts"
import { createSource } from "./reader.ts"

import type { RegisteredSource, Source, SourceContext, SourceName, SourceReader } from "./types.ts"

const sourceRegistry = new Map<string, Source>()

export function registerSource<const TName extends string, const TSource extends Source>(
  name: TName,
  source: TSource,
): TSource {
  sourceRegistry.set(name, source)
  return source
}

export function registerSources<const TSources extends Record<string, Source>>(sources: TSources): TSources {
  for (const [name, source] of Object.entries(sources)) {
    registerSource(name, source)
  }
  return sources
}

export function getRegisteredSource<TName extends SourceName>(
  name: TName,
): RegisteredSource<TName> {
  const source = sourceRegistry.get(name)
  if (!source) throw sourceNotFoundError(name)
  return source as RegisteredSource<TName>
}

export function clearSources(): void {
  sourceRegistry.clear()
}

/** Open a registered definition with the same lifecycle as direct Source readers. */
export function useSource<TName extends SourceName>(
  name: TName,
  context?: Partial<SourceContext>,
): SourceReader<RegisteredSource<TName>> {
  return createSource(getRegisteredSource(name), { ...context, source: context?.source ?? name })
}
