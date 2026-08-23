import { hasRuntimeType } from "../internal/runtime-type.ts"
import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"
import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"

import type { AgentCapabilityDefinition } from "../types.ts"
import type {
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticReporter,
  RuntimeResourceInspector,
  RuntimeResourceObservation,
  RuntimeResourceSnapshot,
} from "@vite-hub/runtime"

const monitorContextKey = "vitehub.diagnostics.monitor"

export interface DiagnosticsCapabilityOptions {
  heartbeat?: number
  interval?: number
  peakStepBytes?: number
  reporter?: RuntimeDiagnosticReporter
  resources?: RuntimeResourceInspector
  timeout?: number
}

interface DiagnosticsMonitor {
  sample(reason: "finish" | "poll" | "start"): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

declare global {
  interface ViteHubAgentInvocationContextValues {
    "vitehub.diagnostics.monitor": DiagnosticsMonitor
  }
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > 2_147_483_647) {
    throw new TypeError(`[vitehub] diagnostics({ ${label} }) must be a positive duration in milliseconds.`)
  }
  return resolved
}

function positiveBytes(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError("[vitehub] diagnostics({ peakStepBytes }) must be a positive number of bytes.")
  }
  return resolved
}

function defaultReporter(event: RuntimeDiagnosticEvent): void {
  const output = { ...event, event: event.name }
  if (event.level === "error") console.error(output)
  else if (event.level === "warn") console.warn(output)
  else console.info(output)
}

function boundedReporter(reporter: RuntimeDiagnosticReporter, timeout: number): RuntimeDiagnosticReporter {
  let active: Promise<void> | undefined
  const wait = async (delivery: Promise<void>, duration = timeout): Promise<boolean> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException("Diagnostic reporting timed out.", "TimeoutError")), duration)
    try {
      await Promise.race([
        delivery,
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
      ])
      return true
    }
    catch (error) {
      console.warn({
        component: "@vite-hub/agent",
        error: normalizeRuntimeDiagnosticError(error, { includeStack: true }),
        event: "agent.diagnostics.report.failed",
        timestamp: new Date().toISOString(),
      })
      return false
    }
    finally {
      clearTimeout(timer)
    }
  }
  return async (event) => {
    const deadline = Date.now() + timeout
    while (active) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      if (!await wait(active, remaining)) {
        active = undefined
        break
      }
    }
    const delivery = Promise.resolve().then(() => reporter(event))
    const slot = delivery.then(() => undefined, () => undefined)
    active = slot
    void slot.then(() => {
      if (active === slot) active = undefined
    })
    await wait(delivery)
  }
}

function peakObservations(snapshot: RuntimeResourceSnapshot): RuntimeResourceObservation[] {
  return snapshot.observations.filter(observation => observation.unit === "bytes" && (observation.name.endsWith(".peak") || observation.name === "memory.max_rss"))
}

function createMonitor(options: {
  heartbeat: number
  inspector: RuntimeResourceInspector
  interval: number
  peakStepBytes: number
  reporter: RuntimeDiagnosticReporter
  runId?: string
  timeout: number
}): DiagnosticsMonitor {
  const peaks = new Map<string, number>()
  let activeAttempt: Promise<void> | undefined
  let activeInspection: Promise<void> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let lastHeartbeatAt = 0
  let pending: "finish" | "poll" | "start" | undefined
  let stopped = false

  const emit = async (name: string, snapshot: RuntimeResourceSnapshot, reason: string) => await options.reporter({
    attributes: {
      reason,
      ...(options.runId ? { run_id: options.runId } : {}),
      resource: snapshot,
    },
    component: "@vite-hub/agent",
    level: "info",
    name,
    timestamp: snapshot.observedAt,
  })

  const inspect = async (reason: "finish" | "poll" | "start", inspection: Promise<RuntimeResourceSnapshot>, controller: AbortController) => {
    const timer = setTimeout(() => controller.abort(new DOMException("Resource inspection timed out.", "TimeoutError")), options.timeout)
    try {
      const snapshot = await Promise.race([
        inspection,
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
      ])
      const changed: RuntimeResourceObservation[] = []
      for (const observation of peakObservations(snapshot)) {
        const key = `${observation.source}:${observation.scope}:${observation.name}`
        const previous = peaks.get(key)
        if (previous === undefined || observation.value >= previous + options.peakStepBytes) {
          peaks.set(key, observation.value)
          if (previous !== undefined) changed.push(observation)
        }
      }
      if (changed.length) {
        await options.reporter({
          attributes: {
            ...(options.runId ? { run_id: options.runId } : {}),
            peaks: changed,
            reason,
            resource: snapshot,
          },
          component: "@vite-hub/agent",
          level: "warn",
          name: "agent.resource.peak",
          timestamp: snapshot.observedAt,
        })
      }
      const now = Date.now()
      if (reason !== "poll" || now - lastHeartbeatAt >= options.heartbeat) {
        await emit("agent.resource.snapshot", snapshot, reason)
        lastHeartbeatAt = now
      }
    }
    catch (error) {
      await options.reporter({
        attributes: { reason, ...(options.runId ? { run_id: options.runId } : {}) },
        component: "@vite-hub/agent",
        error: normalizeRuntimeDiagnosticError(error, { includeStack: true }),
        level: "warn",
        name: "agent.resource.inspect.failed",
        timestamp: new Date().toISOString(),
      })
    }
    finally {
      clearTimeout(timer)
    }
  }

  const drain = (reason: "finish" | "poll" | "start"): Promise<void> => {
    if (activeInspection) {
      if (reason === "finish" || pending !== "finish") pending = reason
      return activeAttempt || Promise.resolve()
    }
    const controller = new AbortController()
    const controlledInspection = Promise.resolve().then(() => options.inspector.inspect({ signal: controller.signal }))
    const task = inspect(reason, controlledInspection, controller)
    activeAttempt = task
    const slot = Promise.all([
      controlledInspection.then(() => undefined, () => undefined),
      task,
    ]).then(() => undefined)
    activeInspection = slot
    void slot.then(() => {
      if (activeInspection !== slot) return
      activeAttempt = undefined
      activeInspection = undefined
      const next = pending
      pending = undefined
      if (next && (!stopped || next === "finish")) void drain(next)
    })
    return task
  }

  return {
    sample: drain,
    async stop() {
      if (stopped) return
      stopped = true
      if (interval) clearInterval(interval)
      interval = undefined
      if (!activeInspection) {
        await drain("finish")
        return
      }
      pending = "finish"
      let timer: ReturnType<typeof setTimeout> | undefined
      const settled = await Promise.race([
        activeInspection.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), options.timeout)
        }),
      ])
      if (timer) clearTimeout(timer)
      if (!settled) {
        pending = undefined
        return
      }
      await Promise.resolve()
      await activeAttempt
    },
    async start() {
      await drain("start")
      interval = setInterval(() => void drain("poll"), options.interval)
      interval.unref?.()
    },
  }
}

export function diagnostics(
  options: DiagnosticsCapabilityOptions = {},
): AgentCapabilityDefinition {
  if (!options || !hasRuntimeType(options, "object")) throw new TypeError("[vitehub] diagnostics() requires an options object when provided.")
  const heartbeat = positiveDuration(options.heartbeat, 60_000, "heartbeat")
  const interval = positiveDuration(options.interval, 10_000, "interval")
  const peakStepBytes = positiveBytes(options.peakStepBytes, 64 * 1024 * 1024)
  const timeout = positiveDuration(options.timeout, 1_000, "timeout")
  if (interval > heartbeat) throw new TypeError("[vitehub] diagnostics({ interval }) cannot exceed diagnostics({ heartbeat }).")
  const reporter = boundedReporter(options.reporter || defaultReporter, timeout)
  const capability = defineCapability({
    id: "diagnostics",
    metadata: {
      ...(options.resources ? { resources: true } : {}),
      ...(options.resources ? { heartbeat, interval, peakStepBytes, timeout } : {}),
    },
    async prepare(context) {
      if (!options.resources) return
      const monitor = createMonitor({
        heartbeat,
        inspector: options.resources,
        interval,
        peakStepBytes,
        reporter,
        runId: context.run?.runId,
        timeout,
      })
      context.context.set(monitorContextKey, monitor)
      await monitor.start()
    },
    async close(context) {
      await context.context.get(monitorContextKey)?.stop()
    },
    async finish(event) {
      const cancelled = event.error !== undefined && event.input.abortSignal?.aborted === true
      await reporter({
        attributes: {
          duration_ms: event.invocation.durationMs,
          outcome: cancelled ? "cancelled" : event.error ? "failed" : "completed",
          ...(event.invocation.run?.runId ? { run_id: event.invocation.run.runId } : {}),
        },
        component: "@vite-hub/agent",
        ...(event.error ? { error: normalizeRuntimeDiagnosticError(event.error, { includeStack: true }) } : {}),
        level: cancelled ? "info" : event.error ? "error" : "info",
        name: "agent.invocation.terminal",
        timestamp: new Date().toISOString(),
      })
    },
  })
  return Object.assign(capability, { [eagerFinishExtensionSymbol]: true })
}
