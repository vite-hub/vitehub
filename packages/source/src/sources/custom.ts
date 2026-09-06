import type { Source } from "../core/types.ts"

export function custom<const TSource extends Source>(source: TSource): TSource {
  return source
}
