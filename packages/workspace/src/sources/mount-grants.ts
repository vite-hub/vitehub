import { workspaceError } from "../core/errors.ts"
import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { registerWorkspaceStoreAlias } from "../storage/identity.ts"
import { forwardWorkspaceStoreTarget } from "../storage/target.ts"

import type { WorkspaceStore } from "../core/types.ts"

/**
 * Proof that one Source owner may change Workspace files inside one Source mount.
 * Only the authority of the owner creates a grant. A grant is request-scoped. Do not persist it.
 */
class WorkspaceSourceMountGrant {
  readonly #mountPath: string
  readonly #source: string

  constructor(source: string, mountPath: string) {
    this.#mountPath = mountPath
    this.#source = source
    Object.freeze(this)
  }

  get mountPath(): string {
    return this.#mountPath
  }

  get source(): string {
    return this.#source
  }
}

export type { WorkspaceSourceMountGrant }

/** A root Source (empty mount) owns every Workspace path. */
export function sourceMountOwnsPath(source: { mountPath: string }, path: string): boolean {
  return !source.mountPath || path === source.mountPath || path.startsWith(`${source.mountPath}/`)
}

/**
 * Creates the grant authority of one Source owner, for example Source Sync or Source materialization.
 * Keep the authority private to its owner module. Grants from one authority do not unlock another authority.
 */
export function createWorkspaceSourceMountAuthority(owner: string) {
  const grants = new WeakMap<WorkspaceSourceMountGrant, { mountPath: string, source: string }>()

  return {
    /** Creates a grant bound to the Source key and its normalized mount. */
    grant(source: { key: string, mountPath: string }): WorkspaceSourceMountGrant {
      const mountPath = normalizeSafeWorkspacePath(source.mountPath, { allowEmpty: true })
      const grant = new WorkspaceSourceMountGrant(source.key, mountPath)
      grants.set(grant, { mountPath, source: source.key })
      return grant
    },
    /**
     * Returns the Store limited to the mount of a grant from this authority.
     * File writes, `mkdir`, and `rm` must stay inside the mount. `removeEmptyDirectory` can also remove
     * an ancestor of the mount, because the owner created it for the mount.
     */
    store(grant: WorkspaceSourceMountGrant, store: WorkspaceStore): WorkspaceStore {
      const scope = grants.get(grant)
      if (!scope) throw workspaceError(`[vitehub] ${owner} requires a Source mount grant to change Workspace files.`)
      const assertInMount = (path: string, allowAncestor = false) => {
        const workspacePath = normalizeSafeWorkspacePath(path, { allowEmpty: true, allowReserved: true })
        if (sourceMountOwnsPath(scope, workspacePath) || allowAncestor && scope.mountPath.startsWith(`${workspacePath}/`)) return path
        throw workspaceError(`[vitehub] ${owner} for Source ${JSON.stringify(scope.source)} cannot change ${path} outside its mount ${JSON.stringify(scope.mountPath)}.`)
      }

      // Call the Store at call time, so wrappers and test doubles still see each call.
      const scoped: WorkspaceStore = {
        readFile: async path => await store.readFile(path),
        writeFile: async (path, file) => await store.writeFile(assertInMount(path), file),
        list: async (prefix, options) => await store.list(prefix, options),
        glob: async (pattern, options) => await store.glob(pattern, options),
        stat: async path => await store.stat(path),
        mkdir: async (path, options) => await store.mkdir(assertInMount(path), options),
        rm: async (path, options) => await store.rm(assertInMount(path), options),
        snapshot: async options => await store.snapshot(options),
        diff: async options => await store.diff(options),
      }
      if (store.writeFileConditional) scoped.writeFileConditional = async (path, file, ifDigest) => await store.writeFileConditional!(assertInMount(path), file, ifDigest)
      if (store.writeFileStream) scoped.writeFileStream = async (path, file) => await store.writeFileStream!(assertInMount(path), file)
      if (store.removeEmptyDirectory) scoped.removeEmptyDirectory = async path => await store.removeEmptyDirectory!(assertInMount(path, true))
      if (store.getMeta) scoped.getMeta = async key => await store.getMeta!(key)
      if (store.setMeta) scoped.setMeta = async (key, value) => await store.setMeta!(key, value)
      // Ownership records and mutation queues stay shared with the Store.
      registerWorkspaceStoreAlias(scoped, store)
      forwardWorkspaceStoreTarget(store, scoped)
      return scoped
    },
  }
}
