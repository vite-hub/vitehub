import type { Source } from "./types.ts"

/** Define a loader. Open it with createSource() to bind its runtime context. */
export function defineSource<const TSource extends Source>(source: TSource): TSource {
  return source
}
