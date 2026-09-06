import { file, type FileSourceOptions } from "./file.ts"

import type { FileSource } from "../core/types.ts"

export function markdown<const TKey extends string = string>(options: FileSourceOptions<TKey>): FileSource<TKey> {
  return file<TKey>({
    ...options,
    mediaType: options.mediaType || "text/markdown",
  } as FileSourceOptions<TKey>)
}
