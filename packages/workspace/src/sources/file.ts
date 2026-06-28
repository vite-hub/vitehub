import { file as createFileSource, type FileSourceOptions as SourcePackageFileSourceOptions } from "@vite-hub/source"

import { normalizeSafeWorkspacePath } from "../core/path.ts"

import type { WorkspaceSource } from "../core/types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "instructions" | "materialize" | "mount" | "probeKeys" | "scopes" | "sync" | "validate">
type SourceScopes<T> = T extends { scopes?: infer TScopes } ? { scopes?: TScopes } : {}
type TypedWorkspaceSource<T> = WorkspaceSource & SourceScopes<T>

export type FileSourceOptions<TKey extends string = string> = SourcePackageFileSourceOptions<TKey> & SourceRuntimeOptions
export type FileSourceInput<TKey extends string = string> = FileSourceOptions<TKey> | TKey

export function file<const TKey extends string = string, const TInput extends FileSourceInput<TKey> = FileSourceInput<TKey>>(input: TInput): TypedWorkspaceSource<TInput> {
  const options = (typeof input === "string" ? { path: input } : input) as FileSourceOptions<TKey>
  const key = normalizeSafeWorkspacePath(options.workspacePath || options.path || "")
  const mount = typeof options.mount === "object" && options.mount && !("path" in options.mount)
    ? { ...options.mount, path: "" }
    : options.mount ?? ""
  const source = createFileSource(options)
  return {
    ...source,
    cache: options.cache,
    instructions: options.instructions,
    materialize: options.materialize,
    mount,
    probeKeys: options.probeKeys || [key],
    scopes: options.scopes,
    sync: options.sync,
    validate: options.validate,
  } as unknown as TypedWorkspaceSource<TInput>
}
