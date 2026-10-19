import { file as createFileSource, type FileSourceOptions as SourcePackageFileSourceOptions } from "@vite-hub/source/file"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
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
  const workspacePath = ownSourceOption(options, "workspacePath") || ownSourceOption(options, "path") || ""
  const key = normalizeSafeWorkspacePath(workspacePath)
  const declaredMount = ownSourceOption(options, "mount")
  const mount = typeof declaredMount === "object" && declaredMount && !Object.hasOwn(declaredMount, "path")
    ? { ...declaredMount, path: "" }
    : declaredMount ?? ""
  const source = createFileSource(options)
  return {
    ...withWorkspaceRuntimeOptions(source, { ...options, mount }),
    probeKeys: ownSourceOption(options, "probeKeys") || [key],
  }
}
