import { file, type FileSourceOptions } from "./file.ts"
import type { WorkspaceSource } from "../types.ts"

export function markdown(options: FileSourceOptions): WorkspaceSource {
  return file({
    ...options,
    mediaType: options.mediaType || "text/markdown",
  })
}
