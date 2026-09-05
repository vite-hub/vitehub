import { hasRuntimeType } from "./internal/runtime-type.ts"
import { createLogger, type DrainContext, type WideEvent } from "evlog"
import { createDrainPipeline } from "evlog/pipeline"
import { withExportDeadline } from "./internal/export-deadline.ts"
import { defineCapability, eagerFinishExtensionSymbol } from "./capability-runtime.ts"
import { createPapercutReporter, type PapercutReporterOptions } from "./papercut-reporter.ts"
import { papercuts } from "./capabilities/papercuts.ts"
import { diagnostics } from "./capabilities/diagnostics.ts"
import { agentInvocationId } from "./invocations.ts"
import { sanitizeAgentLog } from "./evlog/privacy.ts"
import type { AgentCapabilityDefinition, AgentFinishEvent, ResolvedAgentRuntimeContext } from "./types.ts"
import type { RuntimeDiagnosticReporter } from "@vite-hub/runtime"

export { sanitizeAgentLog } from "./evlog/privacy.ts"

export interface AgentEvlogExporter {
  capture(event: string, properties: Record<string, unknown>, options?: { uuid?: string, timestamp?: Date, signal?: AbortSignal }): Promise<void>
  exception(error: Error, properties: Record<string, unknown>, signal?: AbortSignal): Promise<void>
  logs(events: WideEvent[], signal?: AbortSignal): Promise<void>
  flush(signal?: AbortSignal): Promise<void>
}

export interface AgentEvlogOptions {
  service: string
  environment: string
  metadata?: Record<string, unknown>
  exporter?: AgentEvlogExporter
  maxPending?: number
  deliveryTimeoutMs?: number
  trustedErrorCodes?: readonly string[]
  sessionUrl?: (invocation: { agentName: string, id: string }) => string
  /** Build Console links for all events and reports from one origin. */
  console?: { origin: string | ((agent: string) => string), base?: string }
  /** Enable resource diagnostics on the same drain. */
  resources?: NonNullable<Parameters<typeof diagnostics>[0]>["resources"]
  /** Durable papercut delivery shares the exporter and its shutdown lifecycle. */
  papercuts?: Omit<PapercutReporterOptions, "send" | "sessionUrl">
}

export interface AgentEvlog {
  capability: AgentCapabilityDefinition
  plugin: (host: AgentEvlogHost) => void
  capture(event: string, properties: Record<string, unknown>, delivery?: { uuid?: string, timestamp?: Date }): Promise<void>
  diagnostics: RuntimeDiagnosticReporter
  event(name: string, properties?: Record<string, unknown>): void
  exception(error: unknown, properties?: Record<string, unknown>): void
  drain(context: DrainContext): void
  status(): { configured: boolean, accepted: number, failed: number, dropped: number, pending: number, closed: boolean }
  flush(): Promise<void>
}

/** One shared exporter per host. Capability invocations keep their metadata separate. */
export function createAgentEvlog(options: AgentEvlogOptions): AgentEvlog {
  if (!options.service?.trim() || !options.environment?.trim()) throw new TypeError("[vitehub] evlog requires service and environment.")
  const maxPending = options.maxPending ?? 1000
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError("[vitehub] evlog maxPending must be a positive integer.")
  const timeoutMs = options.deliveryTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new TypeError("[vitehub] evlog deliveryTimeoutMs must be a positive timer duration.")
  const sessionUrl = options.sessionUrl ?? (options.console ? ({ agentName, id }: { agentName: string, id: string }) => {
    const origin = hasRuntimeType(options.console!.origin, "function") ? options.console!.origin(agentName) : options.console!.origin
    const base = (options.console!.base ?? "/_vitehub").replace(/\/$/, "")
    return new URL(`${base}/agents/${encodeURIComponent(agentName)}/invocations/${encodeURIComponent(id)}`, origin).href
  } : undefined)
  const exporter = options.exporter
  const metadata = { ...options.metadata, service: options.service, environment: options.environment }
  const pending = new Set<Promise<unknown>>()
  const counts = { accepted: 0, failed: 0, dropped: 0 }
  let closing = false
  let flush: Promise<void> | undefined
  const logs = createDrainPipeline<WideEvent>({
    batch: { size: 25, intervalMs: 1000 },
    retry: { maxAttempts: 1 },
    maxBufferSize: maxPending,
    onDropped(events) { counts.dropped += events.length },
  })(async events => {
    if (!exporter) return
    try { await withExportDeadline(timeoutMs, signal => exporter.logs(events, signal)); counts.accepted += events.length }
    catch (error) { counts.failed += events.length; throw error }
  })

  function track(task: Promise<void>) {
    const tracked = task.then(() => { counts.accepted++ }, () => { counts.failed++ }).finally(() => pending.delete(tracked))
    pending.add(tracked)
    return tracked
  }

  function safeError(error: unknown) {
    let original = error instanceof Error ? error : new Error("Operation failed")
    for (let i = 0; i < 5 && !("code" in original) && original.cause instanceof Error; i++) original = original.cause
    const code = "code" in original && hasRuntimeType(original.code, "string") && /^[a-z0-9_.-]{1,100}$/i.test(original.code) ? original.code : undefined
    const safe = new Error(code && options.trustedErrorCodes?.includes(code) ? String(sanitizeAgentLog({ message: original.message }).message) : "Operation failed")
    safe.name = code || "Error"
    if (original.stack) safe.stack = `${safe.name}: ${safe.message}\n${original.stack.split("\n").filter(line => /^\s+at /.test(line)).map(line => sanitizeAgentLog({ line }).line).join("\n")}`
    return { error: safe, properties: { diagnostic_code: code, diagnostic_fix: "fix" in original ? original.fix : undefined, diagnostic_docs: "docs" in original ? original.docs : undefined } }
  }

  function emit(event: string, properties: Record<string, unknown>, error?: Error) {
    const safe = sanitizeAgentLog({ ...properties, ...metadata, event })
    // Reuse the configured evlog drain unless this integration owns an explicit exporter.
    const logger = createLogger(safe, { _deferDrain: Boolean(exporter) })
    if (error) logger.error(error)
    else if (safe.level === "info" || safe.level === "warn" || safe.level === "error" || safe.level === "debug") logger.setLevel(safe.level)
    const emitted = logger.emit()
    if (emitted && exporter) logs(emitted)
    return safe
  }

  async function capture(event: string, properties: Record<string, unknown>, delivery?: { uuid?: string, timestamp?: Date }) {
    if (closing || !exporter) throw new Error("[vitehub] Agent telemetry delivery is unavailable.")
    if (pending.size >= maxPending) { counts.dropped++; throw new Error("[vitehub] Agent telemetry queue is full.") }
    const task = withExportDeadline(timeoutMs, signal => exporter.capture(event, sanitizeAgentLog({ ...properties, ...metadata }), { ...delivery, signal }))
    // Explicit reports await delivery and propagate failure to their durable reporter.
    void track(task)
    return task
  }

  function event(name: string, properties: Record<string, unknown> = {}) {
    if (closing) { counts.dropped++; return }
    let safe: Record<string, unknown>
    try { safe = emit(name, properties) }
    catch { counts.failed++; return }
    if (!exporter) return
    if (pending.size >= maxPending) { counts.dropped++; return }
    void track(withExportDeadline(timeoutMs, signal => exporter.capture(name, safe, { signal })))
  }

  function exception(error: unknown, properties: Record<string, unknown> = {}) {
    if (closing) { counts.dropped++; return }
    let safe: ReturnType<typeof safeError>
    let attributes: Record<string, unknown>
    try { safe = safeError(error); attributes = emit("operation.failed", { ...properties, ...safe.properties }, safe.error) }
    catch { counts.failed++; return }
    if (!exporter) return
    if (pending.size >= maxPending) { counts.dropped++; return }
    void track(withExportDeadline(timeoutMs, signal => exporter.exception(safe.error, attributes, signal)))
  }

  async function invocationMetadata(runtime: Pick<ResolvedAgentRuntimeContext, "agentIdentity" | "run" | "trace">, run = runtime.run) {
    const agentName = runtime.agentIdentity?.name
    const id = agentName && run?.runId ? await agentInvocationId(run.runId, agentName) : undefined
    return {
      agent_name: agentName, run_id: run?.runId, invocation_id: id, thread_id: run?.threadId,
      trace_id: runtime.trace?.id, parent_trace_id: runtime.trace?.parentId,
      $ai_trace_id: runtime.trace?.id || id,
      session_url: agentName && id ? sessionUrl?.({ agentName, id }) : undefined,
    }
  }

  const summaries = new WeakMap<object, { usage: AgentFinishEvent["invocation"]["usage"], error?: unknown, cancelled: boolean, toolSteps: number }>()
  const capability: AgentCapabilityDefinition = defineCapability({
    id: "evlog",
    instructionCoverage: false,
    async input(context) { event("agent_run_started", await invocationMetadata(context)) },
    finish(result: AgentFinishEvent) {
      summaries.set(result.runtime, { usage: result.invocation.usage, error: result.error, cancelled: result.input.abortSignal?.aborted === true, toolSteps: result.toolResults.length })
    },
    telemetry: {
      async exporter(context) {
        if (context.signal !== "traces") return
        const span = context.spans[0]
        if (!span?.endTime) return
        const summary = summaries.get(context.runtime)
        summaries.delete(context.runtime)
        const attributes = await invocationMetadata(context.runtime)
        const cancelled = summary?.cancelled === true || span.events?.some(event => event.name === "agent.invocation.cancelled") === true
        const failed = !cancelled && span.status.code === "ERROR"
        if (failed) exception(summary?.error || new Error("Agent invocation failed"), attributes)
        const usage = summary?.usage
        const durationMs = Date.parse(span.endTime) - Date.parse(span.startTime)
        event("$ai_trace", {
          ...attributes, model: usage?.model || span.attributes?.["gen_ai.request.model"],
          input_tokens: usage?.usage?.inputTokens, output_tokens: usage?.usage?.outputTokens, total_tokens: usage?.usage?.totalTokens,
          cost_usd: usage?.cost?.usd, cost_estimated: usage?.cost?.estimated, cost_source: usage?.cost?.source,
          $ai_span_name: "agent.run", $ai_latency: durationMs / 1000, $ai_is_error: failed,
          duration_ms: durationMs, tool_steps: summary?.toolSteps,
          status: cancelled ? "cancelled" : failed ? "failed" : "completed",
        })
        // Keep telemetry delivery off the response path, and retain it on serverless hosts.
        context.runtime.waitUntil?.(Promise.allSettled([...pending]))
      },
    },
  })
  // Collect usage even without a user finish hook. Only the terminal trace exports it.
  Object.defineProperty(capability, eagerFinishExtensionSymbol, { value: true })

  const reportDiagnostics: RuntimeDiagnosticReporter = (diagnostic) => {
    if (!["agent.resource.snapshot", "agent.resource.peak", "agent.resource.inspect.failed"].includes(diagnostic.name)) return
    event(diagnostic.name, {
      component: diagnostic.component, level: diagnostic.level, observed_at: diagnostic.timestamp,
      run_id: diagnostic.attributes?.run_id, reason: diagnostic.attributes?.reason,
      resource: diagnostic.attributes?.resource, peaks: diagnostic.attributes?.peaks,
      diagnostic_code: diagnostic.error?.code, diagnostic_status: diagnostic.error?.statusCode || diagnostic.error?.status,
    })
  }

  const reporter = options.papercuts ? createPapercutReporter({
    ...options.papercuts,
    sessionUrl,
    send: delivery => capture("papercut_reported", delivery.properties, { timestamp: new Date(delivery.timestamp), uuid: delivery.uuid }),
    onError: options.papercuts.onError ?? (() => event("papercut.replay.failed", { level: "error" })),
  }) : undefined
  capability.capabilities = [
    ...(options.resources ? [diagnostics({ resources: options.resources, reporter: reportDiagnostics })] : []),
    ...(reporter ? [papercuts({ report: reporter.report })] : []),
  ]
  const telemetry: AgentEvlog = {
    capability, capture, diagnostics: reportDiagnostics, event, exception,
    plugin: host => agentEvlogPlugin(telemetry, reporter ? [reporter] : [])(host),
    drain(context: DrainContext) {
      if (closing || !exporter) return
      const safe = sanitizeAgentLog({ ...context.event, ...metadata })
      if (safe.error) safe.error = { message: "Request failed; inspect the correlated exception." }
      logs({ ...safe, timestamp: context.event.timestamp, level: context.event.level, service: options.service, environment: options.environment })
    },
    status: () => ({ configured: Boolean(exporter), ...counts, pending: pending.size + logs.pending, closed: closing }),
    flush() {
      if (!flush) {
        closing = true
        flush = Promise.allSettled([logs.flush(), ...pending]).then(async () => {
          if (exporter) await withExportDeadline(timeoutMs, signal => exporter.flush(signal))
        })
      }
      return flush
    },
  }
  return telemetry
}

/** Install shared telemetry on a Nitro host. Reporters stop before the exporter drains. */
export interface AgentEvlogHost {
  hooks: {
    hook(name: "request", callback: (event: { req: Request & { context?: { requestId?: string } } }) => void): unknown
    hook(name: "evlog:drain", callback: (context: DrainContext) => void): unknown
    hook(name: "error", callback: (error: unknown, context: { event?: { req: Request & { context?: { requestId?: string } } } }) => void): unknown
    hook(name: "close", callback: () => Promise<void>): unknown
  }
}

export function agentEvlogPlugin(telemetry: AgentEvlog, reporters: readonly { start(): void; stop(): Promise<void> }[] = []): (host: AgentEvlogHost) => void {
  return (host) => {
    host.hooks.hook("request", event => {
      event.req.context ||= {}
      event.req.context.requestId ||= crypto.randomUUID()
    })
    host.hooks.hook("evlog:drain", telemetry.drain)
    host.hooks.hook("error", (error, context) => {
      const request = context.event?.req
      telemetry.exception(error, {
        operation: "http.request",
        method: request?.method,
        path: request ? new URL(request.url).pathname : undefined,
        request_id: request?.context?.requestId,
      })
    })
    if (telemetry.status().configured) for (const reporter of reporters) reporter.start()
    host.hooks.hook("close", async () => {
      try { await Promise.all(reporters.map(reporter => reporter.stop())) }
      finally { await telemetry.flush() }
    })
  }
}
