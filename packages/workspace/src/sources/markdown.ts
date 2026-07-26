import { markdown as createMarkdownSource } from "@vite-hub/source"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { withWorkspaceRuntimeOptions } from "./runtime-options.ts"

import type { FileSourceOptions } from "./file.ts"
import type { WorkspaceSource } from "../core/types.ts"

export function markdown(options: FileSourceOptions): WorkspaceSource {
  const key = normalizeSafeWorkspacePath(options.workspacePath || options.path || "")
  const source = createMarkdownSource(options)
  return {
    ...withWorkspaceRuntimeOptions(source, options),
    probeKeys: options.probeKeys || [key],
  }
}
