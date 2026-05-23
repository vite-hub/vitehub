import { markdown as createMarkdownSource } from "@vitehub/unsource"

import type { FileSourceOptions } from "./file.ts"
import type { WorkspaceSource } from "../core/types.ts"

export function markdown(options: FileSourceOptions): WorkspaceSource {
  const source = createMarkdownSource(options)
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    validate: options.validate,
  }
}
