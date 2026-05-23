import type { WorkspaceLoader } from "../core/types.ts"
import { files, type FilesLoaderOptions } from "./files.ts"

export function json(options: FilesLoaderOptions = {}): WorkspaceLoader {
  return files({
    ...options,
    transform: async (item) => {
      const transformed = options.transform ? await options.transform(item) : item
      if (typeof transformed === "string" || transformed instanceof Uint8Array) return transformed
      return {
        ...transformed,
        mediaType: transformed.mediaType || "application/json",
      }
    },
  })
}
