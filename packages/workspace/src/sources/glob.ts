import { glob as createGlobSource, type GlobSourceOptions as SourcePackageGlobSourceOptions } from "@vite-hub/source/glob"

import { withWorkspaceRuntimeOptions } from "./runtime-options.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"

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
  if (options.materialize === "lazy" || options.materialize === "startup") return true
  return hasRuntimeType(options.mount, "object") && (options.mount?.materialize === "lazy" || options.mount?.materialize === "startup")
}
