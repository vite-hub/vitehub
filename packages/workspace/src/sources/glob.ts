import { glob as createGlobSource, type GlobSourceOptions as SourcePackageGlobSourceOptions } from "@vite-hub/source"

import type { WorkspaceSource } from "../core/types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "scopes" | "sync" | "validate">
type SourceScopes<T> = T extends { scopes?: infer TScopes } ? { scopes?: TScopes } : {}
type TypedWorkspaceSource<T> = WorkspaceSource & SourceScopes<T>
type ExactOptions<TInput, TShape> = TInput & Record<Exclude<keyof TInput, keyof TShape>, never>

export type GlobSourceOptions = SourcePackageGlobSourceOptions & SourceRuntimeOptions

export function glob<const TOptions extends GlobSourceOptions>(options: ExactOptions<TOptions, GlobSourceOptions>): TypedWorkspaceSource<TOptions> {
  const source = createGlobSource({
    ...options,
    keyCache: options.keyCache ?? !isLazySource(options),
  })
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    scopes: options.scopes,
    sync: options.sync,
    validate: options.validate,
  } as unknown as TypedWorkspaceSource<TOptions>
}

function isLazySource(options: GlobSourceOptions) {
  if (options.materialize === "lazy") return true
  return typeof options.mount === "object" && options.mount?.materialize === "lazy"
}
