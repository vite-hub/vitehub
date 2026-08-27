import { resolveRegisteredWorkspaceDefinition } from "../core/registry.ts"
import { useWorkspace } from "../core/use.ts"
import { normalizeWorkspaceSources } from "../sources/config.ts"

import type {
  WorkspaceMaterializeSourcesResult,
  WorkspaceName,
} from "../core/types.ts"

export type WorkspacePreparationState =
  | {
      startedAt: string
      status: "preparing"
    }
  | {
      durationMs: number
      finishedAt: string
      result: WorkspaceMaterializeSourcesResult
      startedAt: string
      status: "ready"
    }
  | {
      durationMs: number
      error: string
      finishedAt: string
      startedAt: string
      status: "error"
    }

export interface WorkspacePreparationOptions<Name extends WorkspaceName = WorkspaceName> {
  onStateChange?: (state: WorkspacePreparationState) => void
  retryDelayMs?: number
  sources?: readonly string[]
  validate?: (result: WorkspaceMaterializeSourcesResult) => void | Promise<void>
  workspace: Name
}

export interface WorkspacePreparation {
  getState(): WorkspacePreparationState
  response(): Response
  start(): Promise<WorkspacePreparationState>
  stop(): Promise<void>
}

export function createWorkspacePreparation<Name extends WorkspaceName = WorkspaceName>(
  options: WorkspacePreparationOptions<Name>,
): WorkspacePreparation {
  if (!options || typeof options.workspace !== "string" || !options.workspace.trim()) {
    throw new TypeError("[vitehub] Workspace preparation requires a Workspace name.")
  }
  if (options.sources !== undefined && (!Array.isArray(options.sources) || options.sources.some(source => typeof source !== "string" || !source.trim()))) {
    throw new TypeError("[vitehub] Workspace preparation sources must be non-empty strings.")
  }
  const retryDelayMs = options.retryDelayMs ?? 10_000
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError("[vitehub] Workspace preparation retryDelayMs must be a non-negative finite number.")
  }

  const workspaceName = options.workspace.trim()
  const sources = options.sources === undefined
    ? undefined
    : [...new Set(options.sources.map(source => source.trim()))]
  let state: WorkspacePreparationState = Object.freeze({
    startedAt: new Date().toISOString(),
    status: "preparing",
  })
  let active: Promise<WorkspacePreparationState> | undefined
  let abortController: AbortController | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let stopped = true
  let lifecycle = 0

  const publish = (next: WorkspacePreparationState) => {
    state = Object.freeze(next)
    try {
      options.onStateChange?.(state)
    }
    catch {}
    return state
  }

  const run = async (): Promise<WorkspacePreparationState> => {
    if (stopped) return state
    if (active) return await active

    const attemptLifecycle = lifecycle
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    publish({ startedAt, status: "preparing" })
    const controller = new AbortController()
    abortController = controller
    const attempt = (async () => {
      try {
        const selectedSources = sources ?? normalizeWorkspaceSources(
          (await resolveRegisteredWorkspaceDefinition(workspaceName)).sources,
        ).filter(source => source.materialize === "startup").map(source => source.key)
        if (!selectedSources.length) {
          throw new Error(`[vitehub] Workspace "${workspaceName}" has no startup sources to prepare.`)
        }

        const workspace = useWorkspace(workspaceName, { mode: "write" })
        const result = await workspace.materializeSources({
          abortSignal: controller.signal,
          sources: selectedSources,
        })
        const sourceResults = new Map(result.sources.map(source => [source.source, source]))
        const failures = selectedSources.filter(source => sourceResults.get(source)?.status !== "ready")
        if (failures.length) {
          throw new Error(`[vitehub] Workspace "${workspaceName}" sources failed to prepare: ${failures.join(", ")}.`)
        }
        await options.validate?.(result)

        if (stopped || attemptLifecycle !== lifecycle) return state
        const finishedAtMs = Date.now()
        return publish({
          durationMs: finishedAtMs - startedAtMs,
          finishedAt: new Date(finishedAtMs).toISOString(),
          result,
          startedAt,
          status: "ready",
        })
      }
      catch (error) {
        if (stopped || attemptLifecycle !== lifecycle) return state
        const finishedAtMs = Date.now()
        const next = publish({
          durationMs: finishedAtMs - startedAtMs,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(finishedAtMs).toISOString(),
          startedAt,
          status: "error",
        })
        if (!stopped && attemptLifecycle === lifecycle) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            if (!stopped && attemptLifecycle === lifecycle) void run()
          }, retryDelayMs)
        }
        return next
      }
      finally {
        if (abortController === controller) abortController = undefined
      }
    })()
    active = attempt
    try {
      return await attempt
    }
    finally {
      if (active === attempt) active = undefined
    }
  }

  return Object.freeze({
    getState() {
      return state
    },
    response() {
      const ready = state.status === "ready"
      return Response.json({ ready, status: state.status }, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
        status: ready ? 200 : 503,
      })
    },
    async start() {
      if (started) return active ? await active : state
      started = true
      stopped = false
      const startLifecycle = ++lifecycle
      if (active) await active
      if (!started || stopped || startLifecycle !== lifecycle) return state
      return await run()
    },
    async stop() {
      started = false
      stopped = true
      lifecycle++
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
      const current = active
      abortController?.abort(new Error(`[vitehub] Workspace "${workspaceName}" preparation stopped.`))
      await current
    },
  })
}
