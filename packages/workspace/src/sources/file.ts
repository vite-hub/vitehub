import { file as createFileSource, type FileSourceOptions as UnsourceFileSourceOptions } from "@vitehub/unsource"

import type { WorkspaceSource } from "../types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "validate">

export type FileSourceOptions<TKey extends string = string> = UnsourceFileSourceOptions<TKey> & SourceRuntimeOptions

export function file<const TKey extends string = string>(options: FileSourceOptions<TKey>): WorkspaceSource {
  const source = createFileSource(options)
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    validate: options.validate,
  }
}
