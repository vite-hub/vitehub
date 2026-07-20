import { markdown as createMarkdownSource } from "@vite-hub/source/sources/markdown"

import { normalizeSafeWorkspacePath } from "../core/path.ts"

import type { FileSourceOptions } from "./file.ts"
import type { WorkspaceSource } from "../core/types.ts"

export function markdown(options: FileSourceOptions): WorkspaceSource {
  const key = normalizeSafeWorkspacePath(options.workspacePath || options.path || "")
  const source = createMarkdownSource(options)
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    probeKeys: options.probeKeys || [key],
    sync: options.sync,
    validate: options.validate,
  }
}
