import type { TraceEventLogEntry } from "@vite-hub/runtime"

/** Bounds of one Invocation's activity trace. The CLI reference documents these numbers. */
export const invocationActivityLimits = {
  /** Entries per Invocation. The trace keeps the first entries and counts the others in `activityOmitted`. */
  entries: 1000,
  /** Characters kept from the start of a tool input, a message, a reasoning summary, an approval reason, or an error. */
  text: 1000,
  /** Characters kept from the end of the output of a failed tool call. */
  failedOutput: 2000,
} as const

type ToolStatus = "completed" | "failed" | "running"

interface InvocationToolActivity {
  at: string
  /** Content keys that the journal content policy omitted, such as `tool.input`. */
  contentOmitted?: readonly string[]
  durationMs?: number
  error?: string
  exitCode?: number
  id: string
  /** The command, or the input as JSON, cut to `invocationActivityLimits.text`. */
  input?: string
  kind: "tool"
  name: string
  /** The end of the output, only for a failed call or a non-zero exit code. */
  output?: string
  /** UTF-8 bytes of the command output, the recorded result, or the result as JSON, as the journal kept it. */
  outputBytes?: number
  /** Files that a file change tool call changed. */
  paths?: readonly string[]
  /** The journal shortened this call's input or output when it recorded it. */
  recordTruncated?: true
  status: ToolStatus
  title?: string
}

interface InvocationTextActivity {
  at: string
  kind: "message" | "reasoning"
  phase?: string
  recordTruncated?: true
  text: string
}

interface InvocationUsageActivity {
  at: string
  cachedInputTokens?: number
  costUsd?: string
  inputTokens?: number
  kind: "usage"
  model?: string
  outputTokens?: number
  provider?: string
  reasoningTokens?: number
  totalTokens?: number
}

interface InvocationApprovalActivity {
  approved?: boolean
  at: string
  id: string
  kind: "approval"
  name?: string
  reason?: string
}

interface InvocationErrorActivity {
  at: string
  kind: "error"
  message: string
  recoverable?: true
}

export type InvocationActivityEntry =
  | InvocationApprovalActivity
  | InvocationErrorActivity
  | InvocationTextActivity
  | InvocationToolActivity
  | InvocationUsageActivity

export interface InvocationActivityTrace {
  activity: InvocationActivityEntry[]
  /** Entries past `invocationActivityLimits.entries`. Absent when the trace kept every entry. */
  activityOmitted?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function head(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit} chars]` : text
}

function tail(text: string, limit: number): string {
  return text.length > limit ? `[${text.length - limit} chars+]…${text.slice(-limit)}` : text
}

function json(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? `${item}n` : item)
  }
  catch {
    return undefined
  }
}

const utf8 = new TextEncoder()

/** Codex wraps each command in a login shell. The inner script says what ran. */
function shellScript(command: string): string {
  const match = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  if (!match) return command.trim()
  return match[1] === "'" ? match[2]!.replaceAll("'\\''", "'") : match[2]!.replace(/\\(["\\$`])/g, "$1")
}

/** Provider tool payloads keep the item in `item`; model Driver payloads are the tool input itself. */
function payloadItem(value: unknown): Record<string, unknown> | undefined {
  const payload = record(value)
  return record(payload?.item) ?? payload
}

/**
 * Provider Drivers record reasoning text as commentary deltas whose id starts with the stream kind
 * (`reasoning_text:<item>:<index>` or `reasoning_summary_text:<item>:<index>`), see `providerTextDeltaId`.
 */
function isReasoning(attributes: Record<string, unknown>): boolean {
  if (attributes["message.phase"] === "reasoning") return true
  const id = attributes["message.id"]
  return typeof id === "string" && /^reasoning(?:_summary)?_text:/.test(id)
}

function recordTruncated(attributes: Record<string, unknown>, keys: readonly string[]): boolean {
  if (attributes["vitehub.observation.truncated"] !== true) return false
  const named = attributes["vitehub.observation.truncatedAttributes"]
  return !Array.isArray(named) || named.some(key => keys.includes(String(key)))
}

interface ToolState {
  chunks: string[]
  entry: InvocationToolActivity
  first: TraceEventLogEntry
  last?: TraceEventLogEntry
  omitted: Set<string>
  output?: unknown
}

function finishTool(state: ToolState): InvocationToolActivity {
  const entry = state.entry
  const item = payloadItem(state.output)
  const exitCode = numberValue(item?.exitCode)
  if (exitCode !== undefined) entry.exitCode = exitCode
  const text = stringValue(item?.aggregatedOutput)
    ?? (state.chunks.length ? state.chunks.join("") : undefined)
    ?? (typeof state.output === "string" ? state.output : undefined)
    ?? stringValue(item?.output)
    ?? (state.output === undefined ? undefined : json(state.output))
  if (text !== undefined) entry.outputBytes = utf8.encode(text).length
  if (entry.durationMs === undefined && state.last && state.entry.status !== "running") {
    const duration = Date.parse(state.last.timestamp) - Date.parse(state.first.timestamp)
    if (Number.isFinite(duration) && duration >= 0) entry.durationMs = duration
  }
  if (entry.status === "completed" && exitCode !== undefined && exitCode !== 0) entry.status = "failed"
  if (entry.status === "failed" && text) entry.output = tail(text, invocationActivityLimits.failedOutput)
  if (state.omitted.size) entry.contentOmitted = [...state.omitted]
  return entry
}

function applyToolInput(entry: InvocationToolActivity, input: unknown): void {
  const item = payloadItem(input)
  const command = stringValue(item?.command)
  const changes = Array.isArray(item?.changes) ? item.changes : undefined
  const paths = changes?.flatMap(change => {
    const path = stringValue(record(change)?.path)
    return path ? [path] : []
  }) ?? []
  const fileName = entry.name === "file_change" ? stringValue(item?.fileName) : undefined
  if (fileName && !paths.includes(fileName)) paths.push(fileName)
  if (paths.length) entry.paths = paths
  const text = command ? shellScript(command) : typeof input === "string" ? input : paths.length ? undefined : json(input)
  if (text) entry.input = head(text, invocationActivityLimits.text)
}

/**
 * A compact, ordered activity trace of one Invocation's observations: one entry per tool call, message,
 * reasoning summary, token usage update, approval, and error. It reads what the journal recorded, so the
 * content policy and the observation limits decide what each entry can show.
 */
export function invocationActivityTrace(observations: readonly TraceEventLogEntry[]): InvocationActivityTrace {
  const entries: Array<{ entry: InvocationActivityEntry, sequence: number }> = []
  const tools = new Map<string, ToolState>()
  const approvals = new Map<string, InvocationApprovalActivity>()
  const messages = new Map<string, { entry: InvocationTextActivity, text: string }>()
  let anonymousMessage: string | undefined
  for (const observation of observations) {
    const attributes = observation.attributes ?? {}
    if (observation.name === "agent.title.recorded" || attributes["vitehub.auxiliary.kind"] === "title") continue
    const name = observation.name
    if (name !== "agent.message.delta") anonymousMessage = undefined

    if (name.startsWith("agent.tool.")) {
      const id = stringValue(attributes["tool.id"]) ?? stringValue(attributes["step.id"]) ?? `observation:${observation.sequence}`
      let state = tools.get(id)
      if (!state) {
        state = {
          chunks: [],
          entry: { at: observation.timestamp, id, kind: "tool", name: "unknown", status: "running" },
          first: observation,
          omitted: new Set(),
        }
        tools.set(id, state)
        entries.push({ entry: state.entry, sequence: observation.sequence })
      }
      const entry = state.entry
      const toolName = stringValue(attributes["tool.name"])
      if (toolName && entry.name === "unknown") entry.name = toolName
      const title = stringValue(attributes["tool.title"])
      if (title && !entry.title) entry.title = head(title, invocationActivityLimits.text)
      if (attributes["tool.input"] !== undefined && entry.input === undefined && entry.paths === undefined) applyToolInput(entry, attributes["tool.input"])
      const omitted = attributes["content.omitted"]
      if (Array.isArray(omitted)) for (const key of omitted) if (key === "tool.input" || key === "tool.output") state.omitted.add(key)
      if (recordTruncated(attributes, ["tool.input", "tool.output"])) entry.recordTruncated = true
      if (name === "agent.tool.output") {
        if (typeof attributes["tool.output"] === "string") state.chunks.push(attributes["tool.output"])
        continue
      }
      if (name !== "agent.tool.finish" && name !== "agent.tool.error") continue
      state.last = observation
      if (attributes["tool.output"] !== undefined) state.output = attributes["tool.output"]
      const duration = numberValue(attributes["tool.durationMs"])
      if (duration !== undefined) entry.durationMs = duration
      const error = stringValue(attributes["tool.error"]) ?? (name === "agent.tool.error" ? stringValue(attributes["error.message"]) : undefined)
      if (error) entry.error = head(error, invocationActivityLimits.text)
      // AI SDK telemetry can finish a call after the stream reported its error; a failure stays a failure.
      if (entry.status !== "failed") entry.status = name === "agent.tool.error" || error ? "failed" : "completed"
      continue
    }

    if (name === "agent.message.delta") {
      const content = attributes["message.content"]
      if (typeof content !== "string" || !content) continue
      const role = attributes["message.role"]
      if (role !== undefined && role !== "assistant") continue
      const phase = stringValue(attributes["message.phase"])
      const id = stringValue(attributes["message.id"])
      const key = id ? `${id}:${phase ?? ""}` : anonymousMessage ?? `anonymous:${observation.sequence}`
      if (!id) anonymousMessage = key
      let message = messages.get(key)
      if (!message) {
        const reasoning = isReasoning(attributes)
        message = {
          entry: { at: observation.timestamp, kind: reasoning ? "reasoning" : "message", ...(phase && !reasoning ? { phase } : {}), text: "" },
          text: "",
        }
        messages.set(key, message)
        entries.push({ entry: message.entry, sequence: observation.sequence })
      }
      message.text += content
      message.entry.text = head(message.text, invocationActivityLimits.text)
      if (recordTruncated(attributes, ["message.content"])) message.entry.recordTruncated = true
      continue
    }

    if (name === "agent.usage.recorded") {
      const usage: InvocationUsageActivity = { at: observation.timestamp, kind: "usage" }
      const model = stringValue(attributes["usage.model"])
      const provider = stringValue(attributes["usage.provider"])
      if (model) usage.model = model
      if (provider) usage.provider = provider
      for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "totalTokens"] as const) {
        const value = numberValue(attributes[`usage.${key}`])
        if (value !== undefined) usage[key] = value
      }
      const costUsd = stringValue(attributes["usage.costUsd"])
      if (costUsd !== undefined) usage.costUsd = costUsd
      entries.push({ entry: usage, sequence: observation.sequence })
      continue
    }

    if (name === "agent.approval.request" || name === "agent.approval.decision") {
      const id = stringValue(attributes["approval.id"]) ?? `observation:${observation.sequence}`
      let approval = approvals.get(id)
      if (!approval) {
        approval = { at: observation.timestamp, id, kind: "approval" }
        approvals.set(id, approval)
        entries.push({ entry: approval, sequence: observation.sequence })
      }
      const approvalName = stringValue(attributes["approval.name"])
      if (approvalName) approval.name = approvalName
      if (typeof attributes["approval.approved"] === "boolean") approval.approved = attributes["approval.approved"]
      const reason = stringValue(attributes["approval.reason"])
      if (reason) approval.reason = head(reason, invocationActivityLimits.text)
      continue
    }

    if (name === "agent.stream.error" || name === "agent.invocation.error") {
      const message = stringValue(attributes["error.message"])
      if (!message) continue
      entries.push({
        entry: { at: observation.timestamp, kind: "error", message: head(message, invocationActivityLimits.text), ...(attributes["error.recoverable"] === true ? { recoverable: true as const } : {}) },
        sequence: observation.sequence,
      })
    }
  }
  for (const state of tools.values()) finishTool(state)
  const activity = entries.sort((left, right) => left.sequence - right.sequence).map(({ entry }) => entry)
  const omitted = activity.length - invocationActivityLimits.entries
  return omitted > 0
    ? { activity: activity.slice(0, invocationActivityLimits.entries), activityOmitted: omitted }
    : { activity }
}
