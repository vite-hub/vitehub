import { glob as createGlobSource, type GlobSourceOptions as SourcePackageGlobSourceOptions } from "@vite-hub/source"

import { withWorkspaceRuntimeOptions } from "./runtime-options.ts"

import type { ExactOptions, WorkspaceSourceRuntimeOptions } from "./runtime-options.ts"
import type { WorkspaceSource } from "../core/types.ts"

export type GlobSourceOptions = SourcePackageGlobSourceOptions & WorkspaceSourceRuntimeOptions

export function glob<const TOptions extends GlobSourceOptions>(options: ExactOptions<TOptions, GlobSourceOptions>): WorkspaceSource {
  const source = createGlobSource({
    ...options,
    keyCache: options.keyCache ?? !isLazySource(options),
  })
  return withWorkspaceRuntimeOptions(source, options)
}

function isLazySource(options: GlobSourceOptions) {
  if (options.materialize === "lazy") return true
  return typeof options.mount === "object" && options.mount?.materialize === "lazy"
}
