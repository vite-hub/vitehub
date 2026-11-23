import * as source from "@vite-hub/source"

import { ownSourceOption, withWorkspaceRuntimeOptions } from "./runtime-options.ts"

import type { ExactOptions, WorkspaceSourceRuntimeOptions } from "./runtime-options.ts"
import type { WorkspaceSource } from "../core/types.ts"

export type GlobSourceOptions = source.GlobSourceOptions & WorkspaceSourceRuntimeOptions

export function glob<const TOptions extends GlobSourceOptions>(options: ExactOptions<TOptions, GlobSourceOptions>): WorkspaceSource {
  const fileSource = source.glob({
    ...options,
    keyCache: options.keyCache ?? !isLazySource(options),
  })
  return withWorkspaceRuntimeOptions(fileSource, options)
}

function isLazySource(options: GlobSourceOptions) {
  const materialize = ownSourceOption(options, "materialize")
  if (materialize === "lazy" || materialize === "startup") return true
  const mount = ownSourceOption(options, "mount")
  const mountMaterialize = typeof mount === "object" ? ownSourceOption(mount, "materialize") : undefined
  return mountMaterialize === "lazy" || mountMaterialize === "startup"
}
