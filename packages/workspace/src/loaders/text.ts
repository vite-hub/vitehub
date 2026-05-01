import type { WorkspaceLoader } from "../types.ts"
import { files, type FilesLoaderOptions } from "./files.ts"

export function text(options: FilesLoaderOptions = {}): WorkspaceLoader {
  return files(options)
}
