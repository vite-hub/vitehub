import type { Source } from "./types.ts"

/** Define a loader. Open it with useSource() to bind its runtime context. */
export function defineSource<const TSource extends Source>(source: TSource): TSource {
  return source
}
