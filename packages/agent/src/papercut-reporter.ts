import * as v from "valibot"
import { agentInvocationId, type AgentInvocations } from "./invocations.ts"
import { withExportDeadline } from "./internal/export-deadline.ts"
import { sanitizeAgentLog } from "./evlog/privacy.ts"
import type { PapercutReportEvent } from "./capabilities/papercuts.ts"

export interface PapercutDelivery {
  uuid: string
  timestamp: string
  properties: Record<string, unknown> & { invocation_id: string, papercut_id: string, message: string }
}

export interface PapercutReporterOptions {
  invocations: () => AgentInvocations | Promise<AgentInvocations>
  send: (delivery: PapercutDelivery, signal: AbortSignal) => Promise<void>
  eventPrefix?: string
  intervalMs?: number
  deliveryTimeoutMs?: number
  uuidNamespace?: string
  sessionUrl?: (invocation: { agentName: string, id: string }) => string
  onError?: (error: unknown) => void
}

export interface PapercutReporter {
  report(input: PapercutReportEvent | PapercutDelivery): Promise<void>
  start(): void
  stop(): Promise<void>
}

/** Durable, at-least-once delivery. The destination must deduplicate the stable UUID. */
export function createPapercutReporter(options: PapercutReporterOptions): PapercutReporter {
  const prefix = options.eventPrefix || "agent.papercut"
  const intervalMs = options.intervalMs ?? 60_000
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) throw new TypeError("[vitehub] Papercut replay interval must be a positive timer duration.")
  const timeoutMs = options.deliveryTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new TypeError("[vitehub] Papercut deliveryTimeoutMs must be a positive timer duration.")
  let closing = false
  const reports = new Set<Promise<void>>()
  const pendingEvent = `${prefix}.pending`
  const deliveredEvent = `${prefix}.delivered`
  const active = new Map<string, Promise<void>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let replay: Promise<void> | undefined
  let cursor: string | undefined
  let running = false

  function reportError(error: unknown) {
    try { options.onError?.(error) }
    catch { /* Reporting errors must not stop replay. */ }
  }

  const envelopeSchema = v.object({
    uuid: v.pipe(v.string(), v.uuid()),
    timestamp: v.pipe(v.string(), v.check(value => Number.isFinite(Date.parse(value)))),
    properties: v.looseObject({ invocation_id: v.pipe(v.string(), v.nonEmpty()), papercut_id: v.pipe(v.string(), v.nonEmpty()), message: v.pipe(v.string(), v.nonEmpty()) }),
  })
  function parse(value: unknown): PapercutDelivery | undefined {
    if (!v.is(v.string(), value)) return
    try {
      const result = v.safeParse(envelopeSchema, JSON.parse(value))
      return result.success ? result.output : undefined
    }
    catch { return }
  }

  function deliver(delivery: PapercutDelivery, journal: AgentInvocations): Promise<void> {
    const current = active.get(delivery.uuid)
    if (current) return current
    const sending = (async () => {
      const invocationId = delivery.properties.invocation_id
      const record = await journal.get(invocationId)
      if (record?.observations.some(item => item.name === deliveredEvent && item.attributes?.["papercut.uuid"] === delivery.uuid)) return
      await withExportDeadline(timeoutMs, signal => options.send(delivery, signal))
      const acknowledged = await journal.appendObservation(invocationId, {
        name: deliveredEvent, type: "capability",
        attributes: { "capability.id": "papercuts", "papercut.uuid": delivery.uuid },
      }, { id: `papercut-delivered:${delivery.uuid}` })
      if (!acknowledged?.observations.some(item => item.name === deliveredEvent && item.attributes?.["papercut.uuid"] === delivery.uuid)) {
        throw new Error("[vitehub] Papercut delivery acknowledgement was not persisted.")
      }
    })().finally(() => active.delete(delivery.uuid))
    active.set(delivery.uuid, sending)
    return sending
  }

  async function persist(delivery: PapercutDelivery) {
    if (!parse(JSON.stringify(delivery))) throw new TypeError("[vitehub] Invalid papercut delivery envelope.")
    const journal = await options.invocations()
    const record = await journal.appendObservation(delivery.properties.invocation_id, {
      name: pendingEvent, type: "capability", timestamp: delivery.timestamp,
      attributes: { "capability.id": "papercuts", "papercut.uuid": delivery.uuid },
      payload: { visibility: "public", value: JSON.stringify(delivery) },
    }, { id: `papercut-pending:${delivery.uuid}` })
    if (!record?.observations.some(item => item.name === pendingEvent
      && parse(item.payload?.visibility === "public" ? item.payload.value : item.attributes?.["papercut.envelope"])?.uuid === delivery.uuid)) {
      throw new Error("[vitehub] Papercut must be persisted before delivery.")
    }
    return deliver(delivery, journal)
  }

  async function replayPage() {
    const journal = await options.invocations()
    const page = await journal.list({ cursor, limit: 100 })
    for (const summary of page.invocations) {
      if (closing) return
      if (summary.status === "running" || summary.status === "pending") continue
      if (summary.capabilityIds && !summary.capabilityIds.includes("papercuts")) continue
      const invocation = await journal.get(summary.id)
      const acknowledged = new Set(invocation?.observations.filter(item => item.name === deliveredEvent).map(item => item.attributes?.["papercut.uuid"]))
      for (const observation of invocation?.observations || []) {
        if (closing) return
        if (observation.name !== pendingEvent) continue
        const delivery = parse(observation.payload?.visibility === "public" ? observation.payload.value : observation.attributes?.["papercut.envelope"])
        if (delivery && delivery.properties.invocation_id === invocation?.id && !acknowledged.has(delivery.uuid)) {
          try {
            await deliver(delivery, journal)
            acknowledged.add(delivery.uuid)
          }
          catch (error) { reportError(error) }
        }
      }
    }
    cursor = page.cursor
  }

  function schedule(delay: number) {
    if (!running) return
    timer = setTimeout(() => {
      replay = replayPage().catch(reportError).finally(() => {
        replay = undefined
        schedule(cursor ? 1000 : intervalMs)
      })
    }, delay)
    timer.unref?.()
  }

  return {
    report(input: PapercutReportEvent | PapercutDelivery) {
      if (closing) return Promise.reject(new Error("[vitehub] Papercut reporter is closed."))
      const task = (async () => persist("papercut" in input ? await createPapercutDelivery(input, options) : input))()
      reports.add(task)
      void task.finally(() => reports.delete(task)).catch(() => {})
      return task
    },
    start() { if (closing) throw new Error("[vitehub] Papercut reporter is closed."); if (!running) { running = true; schedule(0) } },
    async stop() {
      closing = true
      running = false
      clearTimeout(timer)
      await withExportDeadline(timeoutMs, async () => { await Promise.allSettled([replay, ...reports, ...active.values()]) })
    },
  }
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
}

/** Preserve the original report ID, timestamp and invocation across export retries. */
export async function createPapercutDelivery(event: PapercutReportEvent, options: Pick<PapercutReporterOptions, "uuidNamespace" | "sessionUrl"> = {}): Promise<PapercutDelivery> {
  const { papercut, context } = event
  const message = papercut.message?.trim()
  if (!papercut.id?.trim() || !message || message.length > 1000 || !Number.isFinite(Date.parse(papercut.createdAt))) {
    throw new TypeError("[vitehub] A papercut requires an ID, timestamp and message of 1–1000 characters.")
  }
  const agentName = papercut.agent?.name || context.agentIdentity?.name
  const run = papercut.run || context.run
  if (!agentName || !run?.runId) throw new TypeError("[vitehub] Papercut reporting requires a persistent invocation identity.")
  const invocationId = await agentInvocationId(run.runId, agentName)
  const bytes = (await sha256(`${options.uuidNamespace || "agent.papercut.v1"}:${papercut.id}`)).slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  const sessionUrl = options.sessionUrl?.({ agentName, id: invocationId })
  const trace = papercut.trace || context.trace
  const properties = sanitizeAgentLog({
    schema_version: 1, created_at: papercut.createdAt,
    agent_name: agentName, run_id: run.runId, thread_id: run.threadId,
    source: papercut.source, capability: "papercuts", tool: "report_papercut",
    trace_id: trace?.id, parent_trace_context_id: trace?.parentId,
    session_url: sessionUrl, session_link_available: Boolean(sessionUrl),
    grouping_fingerprint: Array.from(await sha256(message.toLowerCase().replace(/\s+/g, " ")), byte => byte.toString(16).padStart(2, "0")).join(""),
    message, invocation_id: invocationId, papercut_id: papercut.id,
  })
  return {
    uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    timestamp: new Date(papercut.createdAt).toISOString(),
    properties: { ...properties, invocation_id: invocationId, papercut_id: String(properties.papercut_id), message: String(properties.message) },
  }
}
