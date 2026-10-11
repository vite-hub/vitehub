import { isWorkspaceBytes } from "../core/path.ts"
import type { WorkspaceLoader } from "../core/types.ts"
import { files, type FilesLoaderOptions } from "./files.ts"

export function json(options: FilesLoaderOptions = {}): WorkspaceLoader {
  return files({
    ...options,
    transform: async (item) => {
      const transformed = options.transform ? await options.transform(item) : item
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Loader transforms accept either source items or direct string content.
      if (typeof transformed === "string" || isWorkspaceBytes(transformed)) return transformed
      return {
        ...transformed,
        mediaType: transformed.mediaType || "application/json",
      }
    },
  })
}
