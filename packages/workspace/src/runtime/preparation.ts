import { resolveRegisteredWorkspaceDefinition } from "../core/registry.ts"
import { useWorkspace } from "../core/use.ts"
import { normalizeWorkspaceSources } from "../sources/config.ts"

import type {
  WorkspaceMaterializeSourcesResult,
  WorkspaceName,
} from "../core/types.ts"

export type WorkspacePreparationState =
  | {
      status: "stopped"
      stoppedAt: string
    }
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

const MAX_TIMER_DELAY_MS = 2_147_483_647

async function waitForAbortable<T>(
  operation: T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let removeAbortListener = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener("abort", onAbort)
  })
  try {
    return await Promise.race([operation, aborted])
  }
  finally {
    removeAbortListener()
  }
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
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`[vitehub] Workspace preparation retryDelayMs must be between 0 and ${MAX_TIMER_DELAY_MS}.`)
  }

  const workspaceName = options.workspace.trim()
  const sources = options.sources === undefined
    ? undefined
    : [...new Set(options.sources.map(source => source.trim()))]
  let workspace = useWorkspace(workspaceName, { mode: "write" })
  let state: WorkspacePreparationState = Object.freeze({
    stoppedAt: new Date().toISOString(),
    status: "stopped",
  })
  let active: Promise<WorkspacePreparationState> | undefined
  let starting: Promise<WorkspacePreparationState> | undefined
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
    const controller = new AbortController()
    abortController = controller
    let resolveAttempt!: (state: WorkspacePreparationState) => void
    let rejectAttempt!: (error: unknown) => void
    const attempt = new Promise<WorkspacePreparationState>((resolve, reject) => {
      resolveAttempt = resolve
      rejectAttempt = reject
    })
    active = attempt
    publish({ startedAt, status: "preparing" })
    void (async () => {
      try {
        const selectedSources = sources ?? normalizeWorkspaceSources(
          (await resolveRegisteredWorkspaceDefinition(workspaceName, controller.signal)).sources,
        ).filter(source => source.materialize === "startup").map(source => source.key)
        if (!selectedSources.length) {
          throw new Error(`[vitehub] Workspace "${workspaceName}" has no startup sources to prepare.`)
        }

        const result = await waitForAbortable(
          workspace.materializeSources({
            abortSignal: controller.signal,
            sources: selectedSources,
          }),
          controller.signal,
        )
        const sourceResults = new Map(result.sources.map(source => [source.source, source]))
        const failures = selectedSources.filter(source => sourceResults.get(source)?.status !== "ready")
        if (failures.length) {
          throw new Error(`[vitehub] Workspace "${workspaceName}" sources failed to prepare: ${failures.join(", ")}.`)
        }
        await waitForAbortable(options.validate?.(result), controller.signal)

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
        if (controller.signal.aborted) {
          // Definition synchronization is owned by the facade. Discard a facade
          // whose synchronization was abandoned so a restart gets a fresh attempt.
          workspace = useWorkspace(workspaceName, { mode: "write" })
        }
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
    })().then(resolveAttempt, rejectAttempt)
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
      if (started) return starting ? await starting : active ? await active : state
      started = true
      stopped = false
      const startLifecycle = ++lifecycle
      const transition = (async () => {
        if (active) await active
        if (!started || stopped || startLifecycle !== lifecycle) return state
        return await run()
      })()
      starting = transition
      try {
        return await transition
      }
      finally {
        if (starting === transition) starting = undefined
      }
    },
    async stop() {
      started = false
      stopped = true
      lifecycle++
      publish({
        status: "stopped",
        stoppedAt: new Date().toISOString(),
      })
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
      const current = active
      abortController?.abort(new Error(`[vitehub] Workspace "${workspaceName}" preparation stopped.`))
      await current
    },
  })
}
