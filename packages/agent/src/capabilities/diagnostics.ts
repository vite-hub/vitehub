import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"
import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"

import type { AgentCapabilityDefinition, AgentRuntimeConfig } from "../types.ts"
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

async function report(reporter: RuntimeDiagnosticReporter, event: RuntimeDiagnosticEvent): Promise<void> {
  try {
    await reporter(event)
  }
  catch (error) {
    console.warn({
      component: "@vite-hub/agent",
      error: normalizeRuntimeDiagnosticError(error, { includeStack: true }),
      event: "agent.diagnostics.report.failed",
      timestamp: new Date().toISOString(),
    })
  }
}

function peakObservations(snapshot: RuntimeResourceSnapshot): RuntimeResourceObservation[] {
  return snapshot.observations.filter(observation => observation.name.endsWith(".peak") || observation.name === "memory.max_rss")
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
  let active: Promise<void> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let lastHeartbeatAt = 0
  let pending: "finish" | "poll" | "start" | undefined
  let stopped = false

  const emit = async (name: string, snapshot: RuntimeResourceSnapshot, reason: string) => await report(options.reporter, {
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

  const inspect = async (reason: "finish" | "poll" | "start") => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException("Resource inspection timed out.", "TimeoutError")), options.timeout)
    timer.unref?.()
    try {
      const snapshot = await Promise.race([
        Promise.resolve(options.inspector.inspect({ signal: controller.signal })),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
      ])
      const changed: RuntimeResourceObservation[] = []
      for (const observation of peakObservations(snapshot)) {
        const key = `${observation.source}:${observation.scope}:${observation.name}`
        const previous = peaks.get(key)
        peaks.set(key, Math.max(previous || 0, observation.value))
        if (previous !== undefined && observation.value >= previous + options.peakStepBytes) changed.push(observation)
      }
      if (changed.length) {
        await report(options.reporter, {
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
      await report(options.reporter, {
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
    if (active) {
      if (reason === "finish" || pending !== "finish") pending = reason
      return active.then(() => active || Promise.resolve())
    }
    const task = inspect(reason)
    active = task
    void task.then(() => {
      if (active !== task) return
      active = undefined
      const next = pending
      pending = undefined
      if (next) void drain(next)
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
      await drain("finish")
      while (active) await active
    },
    async start() {
      await drain("start")
      interval = setInterval(() => void drain("poll"), options.interval)
      interval.unref?.()
    },
  }
}

export function diagnostics<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: DiagnosticsCapabilityOptions = {},
): AgentCapabilityDefinition<TRuntimeConfig> {
  if (!options || typeof options !== "object") throw new TypeError("[vitehub] diagnostics() requires an options object when provided.")
  const heartbeat = positiveDuration(options.heartbeat, 60_000, "heartbeat")
  const interval = positiveDuration(options.interval, 10_000, "interval")
  const peakStepBytes = positiveBytes(options.peakStepBytes, 64 * 1024 * 1024)
  const reporter = options.reporter || defaultReporter
  const timeout = positiveDuration(options.timeout, 1_000, "timeout")
  const capability = defineCapability<TRuntimeConfig>({
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
      await context.context.get<DiagnosticsMonitor>(monitorContextKey)?.stop()
    },
    async finish(event) {
      await report(reporter, {
        attributes: {
          duration_ms: event.invocation.durationMs,
          outcome: event.error ? "failed" : "completed",
          ...(event.invocation.run?.runId ? { run_id: event.invocation.run.runId } : {}),
        },
        component: "@vite-hub/agent",
        ...(event.error ? { error: normalizeRuntimeDiagnosticError(event.error, { includeStack: true }) } : {}),
        level: event.error ? "error" : "info",
        name: "agent.invocation.terminal",
        timestamp: new Date().toISOString(),
      })
    },
  })
  return Object.assign(capability, { [eagerFinishExtensionSymbol]: true })
}
