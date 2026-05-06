import { file, type FileSourceOptions } from "./file.ts"

import type { Source } from "./types.ts"

export function markdown<const TKey extends string = string>(options: FileSourceOptions<TKey>): Source<TKey> {
  return file<TKey>({
    ...options,
    mediaType: options.mediaType || "text/markdown",
  } as FileSourceOptions<TKey>)
}
