import { markdown as createMarkdownSource } from "@vite-hub/source/markdown"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { ownSourceOption, withWorkspaceRuntimeOptions } from "./runtime-options.ts"

import type { FileSourceOptions } from "./file.ts"
import type { WorkspaceSource } from "../core/types.ts"

export function markdown(options: FileSourceOptions): WorkspaceSource {
  const workspacePath = Object.hasOwn(options, "workspacePath") && options.workspacePath
    ? options.workspacePath
    : Object.hasOwn(options, "path") && options.path ? options.path : ""
  const key = normalizeSafeWorkspacePath(workspacePath)
  const source = createMarkdownSource(options)
  return {
    ...withWorkspaceRuntimeOptions(source, options),
    probeKeys: ownSourceOption(options, "probeKeys") || [key],
  }
}
