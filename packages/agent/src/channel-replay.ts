import { createRuntimeContext } from "@vite-hub/runtime"

import { AgentInvocationClaimConflict, exclusiveAgentInvocation, inheritedAgentInvocationClaim, type AgentInvocationJournal, pendingAgentInvocationAnnotation, pendingAgentInvocationAnnotations } from "./invocations.ts"
import { agentDiagnostics } from "./agent-diagnostics.ts"
import { agentErrorMessage } from "./agent-error.ts"
import { isResolvedAgentTriggerHandledInvocation, resolveAgentTriggerInvocation, reserveAgentChannelItem, runAgent } from "./index.ts"
import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"
import { agentToolJsonSchema } from "./tool-schema.ts"
import { agentChannelOptions } from "./trigger-runtime.ts"
import { isWorkflowRun } from "./http-response.ts"

import type { AgentChannelHistory, AgentChannelHistoryQuery, AgentInput, AgentRuntimeConfig, AgentRuntimeContext } from "./types.ts"

export interface ReplayChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  /** Continue from the `nextCursor` of an earlier replay. */
  cursor?: string
  /** Record Channel message writes in the trace instead of calling the provider. */
  dryRun?: boolean
  /** Replay items that already have an Invocation. Each replayed item gets a new Invocation ID. */
  force?: boolean
  /** Maximum number of history items to read. Omit it to read every page. */
  limit?: number
  /** Collection query, validated by the Collection's query schema. */
  query?: AgentChannelHistoryQuery
  /** Runtime Context for the Invocations. Omit it outside a host request. */
  runtime?: AgentRuntimeContext<TRuntimeConfig>
  /** Stops the replay before the next history page. */
  signal?: AbortSignal
}

export type ReplayChannelItemStatus = "completed" | "failed" | "skipped" | "started"

export interface ReplayChannelItem {
  /** Error message when `status` is `failed`. */
  error?: string
  /** The Invocation run ID. */
  id: string
  key: string
  /** Why the item was skipped: an existing Invocation, or the trigger answered without an Invocation. */
  reason?: "existing" | "handled"
  status: ReplayChannelItemStatus
}

export interface ReplayChannelResult {
  failed: number
  items: ReplayChannelItem[]
  /** Pass it as `cursor` to continue. `null` when the history has no more items. */
  nextCursor: string | null
  /** Items that started an Invocation. A Workflow runtime reports them as `started`; inline runs as `completed`. */
  processed: number
  skipped: number
}

export interface ChannelHistoryDescription {
  channel: string
  /** JSON Schema of the Collection query input, when the query schema supports conversion. */
  query?: Record<string, unknown>
  trigger: string
}

interface ResolvedChannelHistory {
  history: AgentChannelHistory
  triggerId: string
  triggerName: string
}

function resolveChannelHistory<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  channel: string,
): ResolvedChannelHistory {
  const channels = agentChannelOptions(agent)
  const definition = Object.hasOwn(channels, channel) ? channels[channel] : undefined
  if (!definition) {
    throw agentDiagnostics.AGENT_R0933({ message: `[vitehub] Agent has no Channel "${channel}".` })
  }
  const history = definition.history
  if (!history) {
    throw agentDiagnostics.AGENT_R0933({ message: `[vitehub] Channel "${channel}" has no history. Add history to its defineChannel() options.` })
  }
  const triggerNames = Object.keys(definition.triggers || {})
  const triggerName = history.trigger
  if (triggerName === undefined) {
    if (triggerNames.length !== 1) {
      throw agentDiagnostics.AGENT_R0933({ message: `[vitehub] Channel "${channel}" history requires an explicit trigger when the Channel has ${triggerNames.length} triggers.` })
    }
    return { history, triggerId: `${channel}.${triggerNames[0]}`, triggerName: triggerNames[0]! }
  }
  if (!hasRuntimeType(triggerName, "string") || !triggerNames.includes(triggerName)) {
    throw agentDiagnostics.AGENT_R0930({ message: `[vitehub] Channel "${channel}" history trigger must name one of the Channel triggers: ${triggerNames.join(", ") || "none"}.` })
  }
  return { history, triggerId: `${channel}.${triggerName}`, triggerName }
}

/** Describes a Channel history so a CLI can list the accepted query keys. */
export function describeChannelHistory<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  channel: string,
): ChannelHistoryDescription {
  const { history, triggerName } = resolveChannelHistory(agent, channel)
  let query: Record<string, unknown> | undefined
  try {
    query = history.collection.querySchema ? agentToolJsonSchema(history.collection.querySchema, "input") : undefined
  }
  catch {
    // A schema without JSON Schema conversion still validates on the server.
    query = undefined
  }
  return { channel, ...(query ? { query } : {}), trigger: triggerName }
}

/**
 * Replay IDs are stable per Channel and item key, so a repeated replay skips handled items.
 * Dry runs use their own IDs; a dry run never blocks a later live replay.
 */
export function channelReplayRunId(channel: string, key: string, options: { dryRun?: boolean } = {}): string {
  return `${options.dryRun ? "channel-replay-dry-run" : "channel-replay"}:${encodeURIComponent(channel)}:${encodeURIComponent(key)}`
}

function assertReplayOptions<TRuntimeConfig extends AgentRuntimeConfig>(options: ReplayChannelOptions<TRuntimeConfig>): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw agentDiagnostics.AGENT_R0936({ message: "[vitehub] replayChannel() limit must be a positive integer." })
  }
  if (options.cursor !== undefined && (!hasRuntimeType(options.cursor, "string") || !options.cursor)) {
    throw agentDiagnostics.AGENT_R0936({ message: "[vitehub] replayChannel() cursor must be a non-empty string." })
  }
  if (options.query !== undefined && !isRuntimeRecord(options.query)) {
    throw agentDiagnostics.AGENT_R0936({ message: "[vitehub] replayChannel() query must be an object." })
  }
}

function itemKey(history: AgentChannelHistory, item: unknown, channel: string): string {
  const key = history.key(item)
  if (!hasRuntimeType(key, "string") || !key.trim() || key.length > 512) {
    throw agentDiagnostics.AGENT_R0935({ message: `[vitehub] Channel "${channel}" history key() must return a non-empty string of at most 512 characters.` })
  }
  return key
}

function createMemo(): AgentRuntimeContext["memo"] {
  const values = new Map<string, unknown>()
  return (key, create) => {
    if (!values.has(key)) values.set(key, create())
    // SAFETY: The creator and returned value share the type associated with this memo key.
    return values.get(key) as never
  }
}

/**
 * Sends past Channel messages from the Channel's `history` Collection through its trigger.
 * Each item starts one Invocation. Items that already have an Invocation are skipped unless `force` is set.
 */
export async function replayChannel<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  channel: string,
  options: ReplayChannelOptions<TRuntimeConfig> = {},
): Promise<ReplayChannelResult> {
  assertReplayOptions(options)
  const { history, triggerId } = resolveChannelHistory(agent, channel)
  const agentName = agent.name || options.runtime?.agentIdentity?.name
  const invocations = agent.invocations
  if (!invocations && !options.force && !options.dryRun) {
    throw agentDiagnostics.AGENT_R0934({ message: `[vitehub] Replaying Channel "${channel}" needs Agent Invocations to skip handled items. Configure invocations or the Console, or pass force.` })
  }
  let query: object
  try {
    query = await history.collection.parseQuery(options.query ?? {})
  }
  catch (error) {
    throw agentDiagnostics.AGENT_R0937({ message: `[vitehub] Invalid Channel "${channel}" history query: ${agentErrorMessage(error)}` })
  }
  let runtime: AgentRuntimeContext<TRuntimeConfig>
  let flushWaitUntil: (() => Promise<void>) | undefined
  if (options.runtime) runtime = options.runtime
  else {
    // Outside a host request, replay owns the background work of its Invocations.
    const created = createRuntimeContext({ runtime: "unknown" })
    runtime = { memo: created.memo, runtime: created.runtime, waitUntil: created.waitUntil }
    flushWaitUntil = () => created.flushWaitUntil()
  }
  const result: ReplayChannelResult = { failed: 0, items: [], nextCursor: options.cursor ?? null, processed: 0, skipped: 0 }
  let cursor = options.cursor
  let remaining = options.limit ?? Number.POSITIVE_INFINITY

  const replayItem = async (item: unknown): Promise<ReplayChannelItem> => {
    const key = itemKey(history, item, channel)
    const stableId = channelReplayRunId(channel, key, options)
    const existing = !options.force ? await invocations?.getByRunId(stableId, agentName) : undefined
    if (existing && !(existing.status === "pending" && existing.annotations?.[pendingAgentInvocationAnnotation] === true)) {
      return { id: stableId, key, reason: "existing", status: "skipped" }
    }
    // A forced replay needs a new ID because the stable one already has an Invocation.
    const id = options.force ? `${stableId}:${crypto.randomUUID()}` : stableId
    let reservation: AgentInvocationJournal<TRuntimeConfig> | undefined
    try {
      const itemRuntime = { ...runtime, ...(invocations ? { [exclusiveAgentInvocation]: true } : {}), memo: createMemo(), request: undefined, run: { ...runtime.run, runId: id } }
      if (invocations) reservation = await reserveAgentChannelItem(agent, itemRuntime)
      const invocation = await resolveAgentTriggerInvocation(agent, itemRuntime, triggerId, item)
      if (isResolvedAgentTriggerHandledInvocation(invocation)) { await reservation?.finish("completed"); return { id, key, reason: "handled", status: "skipped" } }
      const run = { ...runtime.run, ...invocation.run, runId: id }
      if (reservation && !await reservation.setRunMetadata({ ...run, annotations: pendingAgentInvocationAnnotations(run.annotations) })) {
        throw new Error("Could not persist the claimed Invocation run metadata.")
      }
      const token = await reservation?.handoffClaim()
      if (reservation && !token) throw new Error("Could not transfer the Invocation execution claim.")
      const output = await runAgent(agent, { ...itemRuntime, ...(token ? { [inheritedAgentInvocationClaim]: token } : {}), run }, {
        ...invocation.input,
        ...(options.dryRun ? { dryRun: true } : {}),
      })
      return { id, key, status: isWorkflowRun(output) ? "started" : "completed" }
    }
    catch (error) {
      await reservation?.releaseClaim()
      if (error instanceof AgentInvocationClaimConflict) return { id, key, reason: "existing", status: "skipped" }
      return { error: agentErrorMessage(error), id, key, status: "failed" }
    }
  }

  try {
    while (remaining > 0 && !options.signal?.aborted) {
      let page: Awaited<ReturnType<AgentChannelHistory["collection"]["page"]>>
      try {
        page = await history.collection.page({
          ...(cursor ? { cursor } : {}),
          ...(Number.isFinite(remaining) ? { limit: remaining } : {}),
          query,
          ...(options.signal ? { signal: options.signal } : {}),
        })
      }
      catch (error) {
        if (cursor && isRuntimeRecord(error) && error.name === "CollectionCursorError") {
          throw agentDiagnostics.AGENT_R0938({ message: `[vitehub] Invalid Channel "${channel}" history cursor.` })
        }
        throw error
      }
      for (const item of page.items.slice(0, Number.isFinite(remaining) ? remaining : undefined)) {
        const replayed = await replayItem(item)
        result.items.push(replayed)
        if (replayed.status === "failed") result.failed += 1
        else if (replayed.status === "skipped") result.skipped += 1
        else result.processed += 1
        remaining -= 1
      }
      result.nextCursor = page.nextCursor
      if (!page.nextCursor || !page.items.length) break
      cursor = page.nextCursor
    }
    return result
  }
  finally {
    await flushWaitUntil?.()
  }
}

export interface ChannelReplayRequestOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  /** Upper bound for `limit` in one request. Keeps one request within host time limits. */
  maxLimit?: number
  runtime?: AgentRuntimeContext<TRuntimeConfig>
  signal?: AbortSignal
}

const replayRequestKeys = new Set(["channel", "cursor", "describe", "dryRun", "force", "limit", "query"])
const replayErrorStatus: Record<string, number> = {
  AGENT_R0933: 404,
  AGENT_R0934: 409,
  AGENT_R0936: 400,
  AGENT_R0937: 400,
  AGENT_R0938: 400,
}

function replayJson(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function isHistoryQuery(value: unknown): value is AgentChannelHistoryQuery {
  return isRuntimeRecord(value) && Object.values(value).every(entry => entry === undefined
    || hasRuntimeType(entry, "string")
    || (Array.isArray(entry) && entry.every(item => hasRuntimeType(item, "string"))))
}

/**
 * Handles one authenticated replay request from `vitehub channels replay`.
 * The host owns authentication. `{ describe: true }` returns the history query schema instead of replaying.
 */
export async function handleChannelReplayRequest<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  body: unknown,
  options: ChannelReplayRequestOptions<TRuntimeConfig> = {},
): Promise<Response> {
  if (!isRuntimeRecord(body)) return replayJson({ message: "Channel replay request must be an object." }, 400)
  const unsupported = Object.keys(body).find(key => !replayRequestKeys.has(key))
  if (unsupported) return replayJson({ message: `Unsupported Channel replay field: ${unsupported}.` }, 400)
  const { channel, cursor, describe, dryRun, force, limit, query } = body
  if (!hasRuntimeType(channel, "string") || !channel) return replayJson({ message: "Channel replay requires a Channel name." }, 400)
  if ([describe, dryRun, force].some(value => value !== undefined && !hasRuntimeType(value, "boolean"))) {
    return replayJson({ message: "describe, dryRun, and force must be booleans." }, 400)
  }
  if (cursor !== undefined && !hasRuntimeType(cursor, "string")) return replayJson({ message: "cursor must be a string." }, 400)
  if (limit !== undefined && !hasRuntimeType(limit, "number")) return replayJson({ message: "limit must be a number." }, 400)
  if (query !== undefined && !isHistoryQuery(query)) return replayJson({ message: "query values must be strings or string arrays." }, 400)
  const maxLimit = options.maxLimit ?? Number.POSITIVE_INFINITY
  try {
    if (describe === true) return replayJson(describeChannelHistory(agent, channel))
    return replayJson(await replayChannel(agent, channel, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(dryRun === true ? { dryRun: true } : {}),
      ...(force === true ? { force: true } : {}),
      ...(limit !== undefined || Number.isFinite(maxLimit) ? { limit: Math.min(limit ?? maxLimit, maxLimit) } : {}),
      ...(query ? { query } : {}),
      ...(options.runtime ? { runtime: options.runtime } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }))
  }
  catch (error) {
    const code = isRuntimeRecord(error) && hasRuntimeType(error.code, "string") ? error.code : undefined
    const status = code ? replayErrorStatus[code] : undefined
    if (status) return replayJson({ code, message: agentErrorMessage(error) }, status)
    console.error(error)
    return replayJson({ message: "Channel replay failed." }, 500)
  }
}
