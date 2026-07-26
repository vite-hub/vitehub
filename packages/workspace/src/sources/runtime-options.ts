import type { WorkspaceSource } from "../core/types.ts"

export type ExactOptions<TInput, TShape> = TInput & Record<Exclude<keyof TInput, keyof TShape>, never>

export type WorkspaceSourceRuntimeOptions = Pick<
  WorkspaceSource,
  "cache" | "materialize" | "mount" | "sync" | "validate"
>

export function withWorkspaceRuntimeOptions(
  source: WorkspaceSource,
  options: WorkspaceSourceRuntimeOptions,
): WorkspaceSource {
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    sync: options.sync,
    validate: options.validate,
  }
}
