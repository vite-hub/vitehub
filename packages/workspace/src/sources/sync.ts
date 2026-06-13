import { WorkspaceError } from "../core/errors.ts"
import { normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, type ResolvedWorkspaceSource } from "./config.ts"

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

interface SourceSyncStatePath {
  digest: string
  mediaType?: string
  sourcePath: string
}

interface SourceSyncState {
  configHash: string
  mountPath: string
  paths: Record<string, SourceSyncStatePath>
  source: string
  syncedAt: string
}

interface SourceSyncPlan {
  counts: WorkspaceSourceSyncCounts
  files: WorkspaceFile[]
  nextState: SourceSyncState
  paths: WorkspaceSourceSyncPathResult[]
  removals: WorkspaceSourceSyncPathResult[]
  source: ResolvedWorkspaceSource
}

const sourceSyncLocks = new Map<string, Promise<WorkspaceSourceSyncResult>>()

function sourceSyncMetaKey(sourceKey: string) {
  return `source:${sourceKey}:sync`
}

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

function contentFromItem(item: WorkspaceSourceItem) {
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

function readSourceSyncState(value: unknown): SourceSyncState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const state = value as SourceSyncState
  if (typeof state.source !== "string" || typeof state.mountPath !== "string") return
  if (!state.paths || typeof state.paths !== "object" || Array.isArray(state.paths)) return
  return state
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
      throw new WorkspaceError(defined
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

async function planSourceSync(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  source: ResolvedWorkspaceSource,
): Promise<SourceSyncPlan> {
  const ctx = createSourceContext(definition, source)
  const [previousState, configHash, items] = await Promise.all([
    store.getMeta?.(sourceSyncMetaKey(source.key)).then(readSourceSyncState),
    sourceConfigHash(source),
    getSourceItems(source, ctx),
  ])
  const counts = zeroCounts()
  const paths: WorkspaceSourceSyncPathResult[] = []
  const files: WorkspaceFile[] = []
  const nextPaths: SourceSyncState["paths"] = {}

  for (const item of items) {
    const sourcePath = item.path || item.key
    const path = normalizeWorkspacePath(`${source.mountPath}/${sourcePath}`)
    const content = contentFromItem(item)
    const digest = await sha256(content)
    const existing = await store.readFile(path)
    const existingDigest = existing ? await sha256(existing.content) : undefined
    const status: WorkspaceSourceSyncPathResult["status"] = existing ? existingDigest === digest ? "unchanged" : "updated" : "added"
    countPath(counts, status)
    paths.push({ path, sourcePath: item.key, status })
    nextPaths[path] = {
      digest,
      mediaType: item.mediaType,
      sourcePath: item.key,
    }
    files.push({
      path,
      content,
      mediaType: item.mediaType,
      metadata: {
        ...item.metadata,
        source: source.key,
        sourcePath: item.key,
      },
    })
  }

  const removals: WorkspaceSourceSyncPathResult[] = []
  if (source.sync && source.sync.stale === "remove" && previousState) {
    for (const [path, metadata] of Object.entries(previousState.paths)) {
      if (nextPaths[path]) continue
      const file = await store.readFile(path)
      if (file?.metadata?.source !== source.key) continue
      const removal = { path, sourcePath: metadata.sourcePath, status: "removed" as const }
      removals.push(removal)
      paths.push(removal)
      countPath(counts, "removed")
    }
  }

  return {
    counts,
    files,
    nextState: {
      configHash,
      mountPath: source.mountPath,
      paths: nextPaths,
      source: source.key,
      syncedAt: new Date().toISOString(),
    },
    paths,
    removals,
    source,
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
  await store.setMeta?.(sourceSyncMetaKey(plan.source.key), plan.nextState)
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

  if (statuses.some(status => status.status === "error")) {
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
  const snapshot = resultStatus(resultSources) === "ready" || options.publishPartial
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
    throw new WorkspaceError("[vitehub] workspace.sync({ sources }) requires an explicit Source selection.")
  }

  if (!store.getMeta || !store.setMeta) {
    throw new WorkspaceError("[vitehub] Workspace Source Sync requires a Workspace Store with metadata support.")
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
