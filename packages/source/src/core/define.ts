import type { Source } from "./types.ts"

export function defineSource<const TSource extends Source>(source: TSource): TSource {
  return source
}

export function defineSources<const TSources extends Record<string, Source>>(sources: TSources): TSources {
  return sources
}
