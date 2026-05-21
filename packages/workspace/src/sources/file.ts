import { file as createFileSource, type FileSourceOptions as UnsourceFileSourceOptions } from "@vitehub/unsource"

import type { WorkspaceSource } from "../types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "validate">

export type FileSourceOptions<TKey extends string = string> = UnsourceFileSourceOptions<TKey> & SourceRuntimeOptions
export type FileSourceInput<TKey extends string = string> = FileSourceOptions<TKey> | TKey

export function file<const TKey extends string = string>(input: FileSourceInput<TKey>): WorkspaceSource {
  const options = typeof input === "string" ? { path: input } as FileSourceOptions<TKey> : input
  const source = createFileSource(options)
  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount ?? "",
    validate: options.validate,
  }
}
