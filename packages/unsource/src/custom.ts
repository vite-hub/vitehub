import type { Source } from "./types.ts"

export function custom<const TSource extends Source>(source: TSource): TSource {
  return source
}
