import { workspaceError } from "../core/errors.ts"
import { contentStreamToBytes, sha256 } from "../core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountContainsPath, type ResolvedWorkspaceSource } from "./config.ts"
import { normalizeSourceItemPath } from "./source-items.ts"
import {
  readWorkspaceSourceSyncState,
  sourceSyncMetaKey,
  workspaceSourceSyncStateEquals,
  type WorkspaceSourceSyncState,
} from "./sync-state.ts"

import type {
  SnapshotOptions,
  WorkspaceDefinition,
  WorkspaceFile,
  WorkspaceSnapshot,
  WorkspaceSourceItem,
  WorkspaceSourceSyncCounts,
  WorkspaceSourceSyncPathResult,
  WorkspaceSourceSyncResult,
  WorkspaceSourceSyncStatus,
  WorkspaceStore,
  WorkspaceSyncOptions,
} from "../core/types.ts"

interface SourceSyncPlan {
  counts: WorkspaceSourceSyncCounts
  files: WorkspaceFile[]
  nextState: WorkspaceSourceSyncState
  paths: WorkspaceSourceSyncPathResult[]
  removals: WorkspaceSourceSyncPathResult[]
  source: ResolvedWorkspaceSource
  stateChanged: boolean
}

const sourceSyncLocks = new Map<string, Promise<WorkspaceSourceSyncResult>>()

function zeroCounts(): WorkspaceSourceSyncCounts {
  return {
    added: 0,
    removed: 0,
    unchanged: 0,
    updated: 0,
  }
}

function countPath(counts: WorkspaceSourceSyncCounts, status: WorkspaceSourceSyncPathResult["status"]) {
  counts[status]++
}

async function contentFromItem(item: WorkspaceSourceItem) {
  if (item.contentStream) {
    if (typeof item.content !== "undefined" || typeof item.data !== "undefined") {
      throw workspaceError("[vitehub] Workspace source items cannot define contentStream with content or data.")
    }
    return await contentStreamToBytes(item.contentStream)
  }
  return item.content ?? (typeof item.data === "undefined" ? "" : JSON.stringify(item.data, null, 2))
}

async function sourceConfigHash(source: ResolvedWorkspaceSource) {
  return await sha256({
    key: source.key,
    mountPath: source.mountPath,
    source: source.source.fingerprint,
    sync: source.sync,
  })
}

function sourceLockKey(definition: WorkspaceDefinition, source: ResolvedWorkspaceSource) {
  return `${definition.name}\0${source.key}`
}

function lockSkippedStatus(source: ResolvedWorkspaceSource): WorkspaceSourceSyncStatus {
  return {
    counts: zeroCounts(),
    mountPath: source.mountPath,
    source: source.key,
    status: "skipped",
  }
}

function resultStatus(sources: WorkspaceSourceSyncStatus[]): WorkspaceSourceSyncResult["status"] {
  if (sources.some(source => source.status === "error")) {
    return sources.some(source => source.status === "ready") ? "partial" : "error"
  }
  if (sources.every(source => source.status === "skipped")) return "skipped"
  return "ready"
}

function selectedSyncSources(definition: WorkspaceDefinition, options: WorkspaceSyncOptions) {
  const sources = normalizeWorkspaceSources(definition.sources).filter(source => source.sync)
  if (options.sources === "all") return sources

  const selected = [...new Set(options.sources)]
  return selected.map((key) => {
    const source = sources.find(item => item.key === key)
    if (!source) {
      const defined = normalizeWorkspaceSources(definition.sources).some(item => item.key === key)
      throw workspaceError(defined
        ? `[vitehub] Workspace source ${JSON.stringify(key)} is not configured for Source Sync. Add sync: true to the source binding.`
        : `[vitehub] Workspace source ${JSON.stringify(key)} does not exist.`)
    }
    return source
  })
}

async function getSourceItems(source: ResolvedWorkspaceSource, ctx: ReturnType<typeof createSourceContext>) {
  await source.source.prepare?.(ctx)
  if (source.source.getItems) return await source.source.getItems(ctx)
  return await Promise.all((await source.source.getKeys(ctx)).map(async key => await source.source.getItem(key, ctx)))
}

async function shouldRemoveStalePath(store: WorkspaceStore, path: string, metadata: WorkspaceSourceSyncState["paths"][string]) {
  const file = await store.readFile(path)
  if (!file) return false
  return await sha256(file.content) === metadata.digest
}

async function planSourceSync(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  source: ResolvedWorkspaceSource,
): Promise<SourceSyncPlan> {
  const ctx = createSourceContext(definition, source)
  const [previousState, configHash, items] = await Promise.all([
    store.getMeta?.(sourceSyncMetaKey(source.key)).then(readWorkspaceSourceSyncState),
    sourceConfigHash(source),
    getSourceItems(source, ctx),
  ])
  const counts = zeroCounts()
  const paths: WorkspaceSourceSyncPathResult[] = []
  const files: WorkspaceFile[] = []
  const nextPaths: WorkspaceSourceSyncState["paths"] = {}

  for (const item of items) {
    const { path, sourcePath } = normalizeSourceItemPath(source, item, { operation: "Source Sync" })
    if (nextPaths[path]) {
      throw workspaceError(`[vitehub] Workspace Source Sync produced duplicate path: ${path}.`)
    }
    const content = await contentFromItem(item)
    const digest = await sha256(content)
    const existing = await store.readFile(path)
    const existingDigest = existing ? await sha256(existing.content) : undefined
    const status: WorkspaceSourceSyncPathResult["status"] = existing ? existingDigest === digest ? "unchanged" : "updated" : "added"
    countPath(counts, status)
    paths.push({ path, sourcePath, status })
    nextPaths[path] = {
      digest,
      mediaType: item.mediaType,
      sourcePath,
    }
    files.push({
      path,
      content,
      mediaType: item.mediaType,
      metadata: {
        ...item.metadata,
        source: source.key,
        sourcePath,
      },
    })
  }

  const removals: WorkspaceSourceSyncPathResult[] = []
  if (source.sync && source.sync.stale === "remove" && previousState) {
    for (const [path, metadata] of Object.entries(previousState.paths)) {
      if (nextPaths[path]) continue
      if (!await shouldRemoveStalePath(store, path, metadata)) continue
      const removal = { path, sourcePath: metadata.sourcePath, status: "removed" as const }
      removals.push(removal)
      paths.push(removal)
      countPath(counts, "removed")
    }
  }

  const nextState = {
    configHash,
    mountPath: source.mountPath,
    paths: nextPaths,
    source: source.key,
  }

  return {
    counts,
    files,
    nextState,
    paths,
    removals,
    source,
    stateChanged: !workspaceSourceSyncStateEquals(previousState, nextState),
  }
}

async function applySourceSyncPlan(store: WorkspaceStore, plan: SourceSyncPlan) {
  if (plan.source.mountPath) await store.mkdir(plan.source.mountPath, { recursive: true })
  for (const file of plan.files) {
    await store.writeFile(file.path, file)
  }
  for (const removal of plan.removals) {
    await store.rm(removal.path, { force: true })
  }
  await pruneEmptySourceDirectories(store, plan.source, plan.removals)
  if (plan.stateChanged) await store.setMeta?.(sourceSyncMetaKey(plan.source.key), plan.nextState)
}

async function pruneEmptySourceDirectories(store: WorkspaceStore, source: ResolvedWorkspaceSource, removals: WorkspaceSourceSyncPathResult[]) {
  const directories = new Set<string>()
  for (const removal of removals) {
    for (const directory of parentDirectories(removal.path)) {
      if (directory === source.mountPath) continue
      if (source.mountPath && !sourceMountContainsPath(source, directory)) continue
      directories.add(directory)
    }
  }

  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    const stat = await store.stat(directory)
    if (stat?.type !== "directory") continue
    if ((await store.list(directory)).length > 0) continue
    await store.rm(directory, { force: true, recursive: true })
  }
}

function parentDirectories(path: string): string[] {
  const parts = path.split("/").filter(Boolean)
  const directories: string[] = []
  for (let index = parts.length - 1; index > 0; index--) {
    directories.push(parts.slice(0, index).join("/"))
  }
  return directories
}

function statusFromPlan(plan: SourceSyncPlan, details: WorkspaceSyncOptions["details"]): WorkspaceSourceSyncStatus {
  return {
    counts: plan.counts,
    mountPath: plan.source.mountPath,
    paths: details === "paths" ? plan.paths : undefined,
    source: plan.source.key,
    status: "ready",
  }
}

async function snapshotSyncedWorkspace(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  options: WorkspaceSyncOptions,
): Promise<WorkspaceSnapshot | undefined> {
  const shouldSnapshot = !!options.snapshot || !!options.publish
  if (!shouldSnapshot) return

  const snapshotOptions = typeof options.snapshot === "object"
    ? options.snapshot
    : {}
  const snapshot = await store.snapshot(normalizeSnapshotOptions(snapshotOptions))
  if (options.publish) {
    const { publishWorkspaceSnapshot } = await import("../lifecycle.ts")
    await publishWorkspaceSnapshot(definition, store, snapshot)
  }
  return snapshot
}

function normalizeSnapshotOptions(options: WorkspaceSyncOptions["snapshot"]): SnapshotOptions {
  if (!options || typeof options !== "object") return { name: "source-sync" }
  return {
    name: options.name || options.message || "source-sync",
  }
}

async function syncWorkspaceSourcesUnlocked(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  options: WorkspaceSyncOptions,
  sources: ResolvedWorkspaceSource[],
  initialStatuses: WorkspaceSourceSyncStatus[],
  started: number,
): Promise<WorkspaceSourceSyncResult> {
  const statuses: WorkspaceSourceSyncStatus[] = [...initialStatuses]
  const plans: SourceSyncPlan[] = []

  for (const source of sources) {
    try {
      plans.push(await planSourceSync(definition, store, source))
    }
    catch (error) {
      statuses.push({
        counts: zeroCounts(),
        error: error instanceof Error ? error.message : String(error),
        mountPath: source.mountPath,
        source: source.key,
        status: "error",
      })
    }
  }

  if (statuses.some(status => status.status === "error") && !options.publishPartial) {
    return {
      durationMs: Date.now() - started,
      published: false,
      sources: [...statuses, ...plans.map(plan => ({
        counts: plan.counts,
        mountPath: plan.source.mountPath,
        paths: options.details === "paths" ? plan.paths : undefined,
        source: plan.source.key,
        status: "skipped" as const,
      }))],
      status: resultStatus(statuses),
    }
  }

  for (const plan of plans) {
    await applySourceSyncPlan(store, plan)
  }

  const planStatuses = plans.map(plan => statusFromPlan(plan, options.details))
  const resultSources = [...statuses, ...planStatuses]
  const snapshot = resultStatus(resultSources) === "ready" || options.publishPartial && planStatuses.length > 0
    ? await snapshotSyncedWorkspace(definition, store, options)
    : undefined

  return {
    durationMs: Date.now() - started,
    published: !!options.publish && !!snapshot,
    snapshot,
    sources: resultSources,
    status: resultStatus(resultSources),
  }
}

export async function syncWorkspaceSources(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  options: WorkspaceSyncOptions,
): Promise<WorkspaceSourceSyncResult> {
  if (!options || !options.sources) {
    throw workspaceError("[vitehub] workspace.sync({ sources }) requires an explicit Source selection.")
  }

  if (!store.getMeta || !store.setMeta) {
    throw workspaceError("[vitehub] Workspace Source Sync requires a Workspace Store with metadata support.")
  }

  const started = Date.now()
  const sources = selectedSyncSources(definition, options)
  if (sources.length === 0) {
    return {
      durationMs: 0,
      published: false,
      sources: [],
      status: "skipped",
    }
  }

  const statuses: WorkspaceSourceSyncStatus[] = []
  const runnableSources: ResolvedWorkspaceSource[] = []
  for (const source of sources) {
    const key = sourceLockKey(definition, source)
    let existing = sourceSyncLocks.get(key)
    while (existing) {
      if (source.sync && source.sync.concurrency === "skip") {
        statuses.push(lockSkippedStatus(source))
        break
      }
      await existing.catch(() => undefined)
      existing = sourceSyncLocks.get(key)
    }
    if (!statuses.some(status => status.source === source.key)) runnableSources.push(source)
  }

  if (runnableSources.length === 0) {
    return {
      durationMs: Date.now() - started,
      published: false,
      sources: statuses,
      status: resultStatus(statuses),
    }
  }

  const lockKeys = runnableSources.map(source => sourceLockKey(definition, source)).sort()
  const promise = syncWorkspaceSourcesUnlocked(definition, store, options, runnableSources, statuses, started)
  for (const key of lockKeys) sourceSyncLocks.set(key, promise)
  try {
    return await promise
  }
  finally {
    for (const key of lockKeys) {
      if (sourceSyncLocks.get(key) === promise) sourceSyncLocks.delete(key)
    }
  }
}
