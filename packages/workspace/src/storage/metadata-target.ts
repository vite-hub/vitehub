import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
/** Internal capability used only by Source Sync through wrapped writable facades. */
export const workspaceInternalMetadataCapability: unique symbol = Symbol("vitehub.workspace.internalMetadata")

import { forwardWorkspaceStoreTarget } from "./target.ts"
import type { ListOptions, MkdirOptions, RmOptions, Workspace, WorkspaceEntry, WorkspaceFile } from "../core/types.ts"

import type { ReadonlyWorkspaceFacade, ReadonlyWorkspaceFs, WritableWorkspaceFacade, WritableWorkspaceFs } from "../core/use.ts"

export interface WorkspaceMetadataTarget {
  workspaceName?: string
  readFile?(path: string): Promise<WorkspaceFile | undefined>
  writeFile?(path: string, file: WorkspaceFile): Promise<void>
  mkdir?(path: string, options?: MkdirOptions): Promise<void>
  rm?(path: string, options?: RmOptions): Promise<void>
  getMeta?(key: string): Promise<unknown>
  list?(path: string, options?: ListOptions): Promise<WorkspaceEntry[]>
}

/** An object that can carry a metadata target: a Workspace, a Workspace facade, or the `fs` of a facade. */
export type WorkspaceMetadataCarrier = Workspace | ReadonlyWorkspaceFacade | WritableWorkspaceFacade | ReadonlyWorkspaceFs | WritableWorkspaceFs

type WorkspaceMetadataTargetResolver = () => Promise<WorkspaceMetadataTarget | undefined> | WorkspaceMetadataTarget | undefined

// A metadata target can write to the raw Store and skip every write grant.
// Keep the resolvers in this module. Do not export them from a package entry.
// Lookups accept any object, because callers pass unknown values. Only carriers are registered.
const metadataTargetResolvers = new WeakMap<WeakKey, WorkspaceMetadataTargetResolver>()

type WorkspaceMetadataStore = WorkspaceMetadataTarget & {
  setMeta?(key: string, value: unknown, capability?: typeof workspaceInternalMetadataCapability): Promise<void>
}

const metadataTargetsByStore = new WeakMap<WorkspaceMetadataTarget, Map<string, WorkspaceMetadataTarget>>()
const metadataSetters = new WeakMap<WorkspaceMetadataTarget, (key: string, value: unknown, capability?: typeof workspaceInternalMetadataCapability) => Promise<void>>()
const facadeMetadataTargets = new WeakMap<object, () => Promise<WorkspaceMetadataTarget | undefined>>()
const privateMetadataTargets = new WeakMap<WorkspaceMetadataTarget, WorkspaceMetadataTarget>()

export function createWorkspaceMetadataTarget(store: WorkspaceMetadataStore, workspaceName: string): WorkspaceMetadataTarget {
  const targets = metadataTargetsByStore.get(store) ?? new Map<string, WorkspaceMetadataTarget>()
  const existing = targets.get(workspaceName)
  if (existing) return existing
  const setMeta = store.setMeta?.bind(store)
  const target: WorkspaceMetadataTarget = {
    workspaceName,
    readFile: store.readFile?.bind(store),
    writeFile: store.writeFile?.bind(store),
    mkdir: store.mkdir?.bind(store),
    rm: store.rm?.bind(store),
    getMeta: store.getMeta?.bind(store),
    list: store.list?.bind(store),
  }
  if (setMeta) metadataSetters.set(target, setMeta)
  const publicTarget = {
    workspaceName,
    readFile: target.readFile,
    getMeta: target.getMeta,
    list: target.list,
  }
  privateMetadataTargets.set(publicTarget, target)
  forwardWorkspaceStoreTarget(store, target)
  forwardWorkspaceStoreTarget(store, publicTarget)
  targets.set(workspaceName, publicTarget)
  metadataTargetsByStore.set(store, targets)
  return publicTarget
}

/** Writes internal metadata without exposing the privileged setter on a facade. */
export async function setWorkspaceMetadata(target: WorkspaceMetadataTarget, key: string, value: unknown): Promise<boolean> {
  const setter = metadataSetters.get(target) || metadataSetters.get(privateMetadataTargets.get(target) ?? target)
  if (!setter) return false
  await setter(key, value, workspaceInternalMetadataCapability)
  return true
}

export function attachWorkspaceMetadataTarget(carrier: WorkspaceMetadataCarrier, resolve: WorkspaceMetadataTargetResolver): void {
  metadataTargetResolvers.set(carrier, resolve)
  if ("fs" in carrier) facadeMetadataTargets.set(carrier.fs, async () => await resolve())
}

export function forwardWorkspaceMetadataTarget(source: unknown, target: WorkspaceMetadataCarrier): void {
  const resolve = metadataTargetResolver(source)
  if (resolve) attachWorkspaceMetadataTarget(target, resolve)
}

export async function resolveWorkspaceMetadataTarget(source: unknown): Promise<WorkspaceMetadataTarget | undefined> {
  return await metadataTargetResolver(source)?.()
}

/**
 * Attaches a read-only metadata view of `source` to `target`.
 * The view has the Workspace name, `getMeta`, `list`, and the Store target. It never has Store writes.
 * `filterEntries` limits the listed entries, for example to an access scope.
 * Internal: `@vite-hub/agent` uses this for its Workspace facades.
 */
export function forwardWorkspaceMetadataView(source: unknown, target: WorkspaceMetadataCarrier, filterEntries?: (entries: WorkspaceEntry[]) => WorkspaceEntry[]): void {
  const resolve = metadataTargetResolver(source)
  if (!resolve) return
  metadataTargetResolvers.set(target, async () => {
    const metadata = await resolve()
    if (!metadata) return
    const list = metadata.list?.bind(metadata)
    const view: WorkspaceMetadataTarget = {
      workspaceName: metadata.workspaceName,
      getMeta: metadata.getMeta?.bind(metadata),
      list: list
        ? async (path, options) => {
            const entries = await list(path, options)
            return filterEntries ? filterEntries(entries) : entries
          }
        : undefined,
    }
    forwardWorkspaceStoreTarget(metadata, view)
    return view
  })
}

function metadataTargetResolver(source: unknown) {
  if (source === null || !(hasRuntimeType(source, "object") || hasRuntimeType(source, "function"))) return undefined
  return metadataTargetResolvers.get(source)
    ?? ("fs" in source && source.fs !== null && hasRuntimeType(source.fs, "object") ? facadeMetadataTargets.get(source.fs) : undefined)
}

export function resolveWorkspaceMetadataMutationTarget(target: WorkspaceMetadataTarget): WorkspaceMetadataTarget {
  return privateMetadataTargets.get(target) ?? target
}
