import { file as createFileSource, type FileSourceOptions as SourcePackageFileSourceOptions } from "@vite-hub/source"

import type { WorkspaceSource } from "../core/types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "validate">

export type FileSourceOptions<TKey extends string = string> = SourcePackageFileSourceOptions<TKey> & SourceRuntimeOptions
export type FileSourceInput<TKey extends string = string> = FileSourceOptions<TKey> | TKey

export function file<const TKey extends string = string>(input: FileSourceInput<TKey>): WorkspaceSource {
  const options = typeof input === "string" ? { path: input } as FileSourceOptions<TKey> : input
  const mount = typeof options.mount === "object" && options.mount && !("path" in options.mount)
    ? { ...options.mount, path: "" }
    : options.mount ?? ""
  const source = createFileSource(options)
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount,
    validate: options.validate,
  }
}
