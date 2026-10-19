import { array } from "@vite-hub/source"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { useWorkspace } from "./core/use.ts"
import { workspaceErrorDiagnostics } from "./error-diagnostics.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ArrayCollectionOptions, ArrayCollectionQuery, ArrayCollectionQueryInput, ProviderCollectionSource } from "@vite-hub/source"
import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade } from "./core/use.ts"
import type { WorkspaceName } from "./core/types.ts"

type WorkspaceFacade<Name extends WorkspaceName> = ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name>

export interface WorkspaceFileCollectionOptions<Name extends WorkspaceName = WorkspaceName, TFilter extends string = string>
  extends ArrayCollectionOptions<TFilter> {
  /** Workspace-relative path of a JSON file that contains one array. */
  path: string
  /** Workspace name, an open Workspace, or a function that opens one per request. */
  workspace: Name | WorkspaceFacade<Name> | (() => WorkspaceFacade<Name> | Promise<WorkspaceFacade<Name>>)
}

async function openWorkspace<Name extends WorkspaceName>(input: WorkspaceFileCollectionOptions<Name>["workspace"]): Promise<WorkspaceFacade<Name>> {
  if (hasRuntimeType(input, "function")) return await input()
  if (hasRuntimeType(input, "string")) return useWorkspace(input)
  return input
}

/**
 * A Collection source over a JSON array stored in a Workspace file.
 *
 * Every request reads the file and queries it in memory with `array()`. The file's Workspace digest binds cursors,
 * so a write to the file makes older cursors stale. Pass `schema` to validate and type the items.
 *
 * @example
 * export const articles = defineCollection({
 *   source: workspaceFile({ workspace: 'catalog', path: 'data/articles.json', filters: ['category'], search: ['title'] }),
 * })
 */
export function workspaceFile<TSchema extends StandardSchemaV1, Name extends WorkspaceName = WorkspaceName, const TFilter extends string = never>(
  options: WorkspaceFileCollectionOptions<Name, TFilter> & { schema: TSchema },
): ProviderCollectionSource<StandardSchemaV1.InferOutput<TSchema>, ArrayCollectionQuery<TFilter>, ArrayCollectionQueryInput<TFilter>>
export function workspaceFile<Name extends WorkspaceName = WorkspaceName, const TFilter extends string = never>(
  options: WorkspaceFileCollectionOptions<Name, TFilter> & { schema?: undefined },
): ProviderCollectionSource<Record<string, unknown>, ArrayCollectionQuery<TFilter>, ArrayCollectionQueryInput<TFilter>>
export function workspaceFile<Name extends WorkspaceName, const TFilter extends string>(
  options: WorkspaceFileCollectionOptions<Name, TFilter> & { schema?: StandardSchemaV1 },
): ProviderCollectionSource<unknown, ArrayCollectionQuery<TFilter>, ArrayCollectionQueryInput<TFilter>> {
  const { path, schema, workspace: input, ...query } = options
  const load = async ({ signal }: { signal?: AbortSignal }) => {
    const workspace = await openWorkspace(input)
    // SAFETY: Workspace paths are typed per registered Workspace; workspaceFile() accepts any path and the store validates it.
    const stat = await workspace.fs.stat(path as never)
    if (stat.type !== "file") throw workspaceErrorDiagnostics.WORKSPACE_R0010({ path })
    // SAFETY: Same path as the stat above; the store rejects paths outside the Workspace.
    const raw = await workspace.fs.readFile(path as never, { encoding: "utf8" })
    signal?.throwIfAborted()
    const items: unknown = JSON.parse(raw)
    if (!Array.isArray(items)) throw workspaceErrorDiagnostics.WORKSPACE_R0011({ path })
    return { digest: stat.digest || undefined, items }
  }
  return schema ? array(load, { ...query, schema }) : array<unknown, TFilter>(load, query)
}
