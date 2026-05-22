import { glob as createGlobSource, type GlobSourceOptions as UnsourceGlobSourceOptions } from "@vitehub/unsource"

import type { WorkspaceSource } from "../core/types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "validate">

export type GlobSourceOptions = UnsourceGlobSourceOptions & SourceRuntimeOptions

export function glob(options: GlobSourceOptions): WorkspaceSource {
  const source = createGlobSource({
    ...options,
    keyCache: options.keyCache ?? !isLazySource(options),
  })
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    validate: options.validate,
  }
}

function isLazySource(options: GlobSourceOptions) {
  if (options.materialize === "lazy") return true
  return typeof options.mount === "object" && options.mount?.materialize === "lazy"
}
