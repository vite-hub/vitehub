import { glob as createGlobSource, type GlobSourceOptions as SourcePackageGlobSourceOptions } from "@vite-hub/source"

import type { WorkspaceSource } from "../core/types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "instructions" | "materialize" | "mount" | "validate">

export type GlobSourceOptions = SourcePackageGlobSourceOptions & SourceRuntimeOptions

export function glob(options: GlobSourceOptions): WorkspaceSource {
  const source = createGlobSource({
    ...options,
    keyCache: options.keyCache ?? !isLazySource(options),
  })
  return {
    ...source,
    cache: options.cache,
    instructions: options.instructions,
    materialize: options.materialize,
    mount: options.mount,
    validate: options.validate,
  }
}

function isLazySource(options: GlobSourceOptions) {
  if (options.materialize === "lazy") return true
  return typeof options.mount === "object" && options.mount?.materialize === "lazy"
}
