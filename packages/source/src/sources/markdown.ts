import { file, type FileSourceOptions } from "./file.ts"

import type { SingleFileSource } from "../core/types.ts"

export function markdown<const TKey extends string = string>(options: FileSourceOptions<TKey>): SingleFileSource<TKey> {
  // SAFETY: The spread retains the caller's FileSourceOptions shape while replacing mediaType with a string default.
  return file<TKey>({
    ...options,
    mediaType: Object.hasOwn(options, "mediaType") && options.mediaType ? options.mediaType : "text/markdown",
  } as FileSourceOptions<TKey>)
}
