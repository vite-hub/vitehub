import { glob as createGlobSource, type GlobSourceOptions as SourcePackageGlobSourceOptions } from "@vite-hub/source/glob"

import { ownSourceOption, withWorkspaceRuntimeOptions } from "./runtime-options.ts"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

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
  const materialize = ownSourceOption(options, "materialize")
  if (materialize === "lazy" || materialize === "startup") return true
  const mount = ownSourceOption(options, "mount")
  const mountMaterialize = hasRuntimeType(mount, "object") ? ownSourceOption(mount, "materialize") : undefined
  return mountMaterialize === "lazy" || mountMaterialize === "startup"
}
