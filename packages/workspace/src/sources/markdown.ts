import { markdown as createMarkdownSource } from "@vite-hub/source"

import { withFileSourceOptions } from "./file.ts"

import type { FileSourceOptions } from "./file.ts"
import type { WorkspaceSource } from "../core/types.ts"

export function markdown(options: FileSourceOptions): WorkspaceSource {
  return withFileSourceOptions(createMarkdownSource(options), options)
}
