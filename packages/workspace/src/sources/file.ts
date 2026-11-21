import { file as createFileSource, type FileSourceOptions as SourcePackageFileSourceOptions } from "@vite-hub/source"

import { ownSourceOption, withWorkspaceRuntimeOptions } from "./runtime-options.ts"

import type { ExactOptions, WorkspaceSourceRuntimeOptions } from "./runtime-options.ts"
import type { WorkspaceSource } from "../core/types.ts"

type FileWorkspaceSourceRuntimeOptions = WorkspaceSourceRuntimeOptions & Pick<WorkspaceSource, "probeKeys">

export type FileSourceOptions<TKey extends string = string> = SourcePackageFileSourceOptions<TKey> & FileWorkspaceSourceRuntimeOptions
export type FileSourceInput<TKey extends string = string> = FileSourceOptions<TKey> | TKey

export function file<const TKey extends string>(input: TKey): WorkspaceSource
export function file<const TKey extends string = string, const TOptions extends FileSourceOptions<TKey> = FileSourceOptions<TKey>>(input: ExactOptions<TOptions, FileSourceOptions<TKey>>): WorkspaceSource
export function file<const TKey extends string = string>(input: FileSourceInput<TKey>): WorkspaceSource {
  const options = (typeof input === "string" ? { path: input } : input) as FileSourceOptions<TKey>
  return withFileSourceOptions(createFileSource(options), options)
}

/** Adds Workspace binding options to a file Source. Workspace normalization picks the default mount and probe keys. */
export function withFileSourceOptions(source: WorkspaceSource, options: FileWorkspaceSourceRuntimeOptions): WorkspaceSource {
  const probeKeys = ownSourceOption(options, "probeKeys")
  return {
    ...withWorkspaceRuntimeOptions(source, options),
    ...(probeKeys ? { probeKeys } : {}),
  }
}
