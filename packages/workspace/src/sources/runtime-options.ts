import type { WorkspaceSource } from "../core/types.ts"

export type ExactOptions<TInput, TShape> = TInput & Record<Exclude<keyof TInput, keyof TShape>, never>

export type WorkspaceSourceRuntimeOptions = Pick<
  WorkspaceSource,
  "cache" | "materialize" | "mount" | "sync" | "validate"
>

export function ownSourceOption<TOptions extends object, TKey extends keyof TOptions>(options: TOptions, key: TKey): TOptions[TKey] | undefined {
  return Object.hasOwn(options, key) ? options[key] : undefined
}

export function withWorkspaceRuntimeOptions(
  source: WorkspaceSource,
  options: WorkspaceSourceRuntimeOptions,
): WorkspaceSource {
  return {
    ...source,
    cache: ownSourceOption(options, "cache"),
    materialize: ownSourceOption(options, "materialize"),
    mount: ownSourceOption(options, "mount"),
    sync: ownSourceOption(options, "sync"),
    validate: ownSourceOption(options, "validate"),
  }
}
