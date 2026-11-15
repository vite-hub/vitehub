// Provider session files as Agent Invocations.
//
// A coding agent that runs outside the app (Codex or Claude Code on a laptop, in CI, on a runner) writes its own
// session file. `readCodexSession()` and `readClaudeCodeSession()` read that file into one provider-neutral
// `AgentSession`. `importAgentSession()` writes it to an Agent Invocation store as a finished Invocation with the
// session's own timestamps, so the Console shows it like a session that ran in the app: messages, thinking, commands
// with their output, file changes as diffs, and usage.

import type { TraceEventLogEntry } from "@vite-hub/runtime"

import { agentDiagnostics } from "./agent-diagnostics.ts"
import { agentInvocationId } from "./invocations.ts"
import type { AgentInvocationAnnotationValue, AgentInvocationStore, AgentInvocationStoreCreateInput } from "./invocations.ts"

/** A coding agent CLI whose session files ViteHub reads. */
export type AgentSessionProvider = "claude-code" | "codex"

export interface AgentSessionUsage {
  inputTokens: number
  /** Included in `inputTokens`. */
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

/** Assistant text. `reasoning` is thinking, `commentary` is a progress note, `final` is the answer. */
export interface AgentSessionMessage {
  type: "message"
  id: string
  timestamp: string
  phase: "commentary" | "final" | "reasoning"
  text: string
}

/**
 * One tool call. Commands use the name `command_execution` with `input.command`, and `output.output` and
 * `output.exitCode` when known. File edits have `kind: "change"` and `output.item.changes` with unified diff hunks.
 */
export interface AgentSessionTool {
  type: "tool"
  id: string
  timestamp: string
  completedAt?: string
  durationMs?: number
  name: string
  title?: string
  kind?: "change" | "tool"
  input?: unknown
  output?: unknown
  error?: string
}

export type AgentSessionStep = AgentSessionMessage | AgentSessionTool

/** A provider session file, read into one provider-neutral shape. */
export interface AgentSession {
  provider: AgentSessionProvider
  /** The provider's session id. */
  id?: string
  cwd?: string
  model?: string
  reasoningEffort?: string
  /** Version of the provider CLI that wrote the file. */
  version?: string
  startedAt?: string
  completedAt?: string
  status: "completed" | "failed"
  error?: string
  /** The first user message. */
  prompt?: string
  /** The final answer. */
  text?: string
  steps: AgentSessionStep[]
  usage: AgentSessionUsage
}

export interface AgentSessionConfiguration {
  /** Skills the harness offered the agent. */
  skills?: { name: string, description?: string, source?: string }[]
  mcpServers?: { name: string, status?: string }[]
  tools?: { name: string, description?: string }[]
  /** The Workspace that holds the session's files: a ViteHub Workspace name and the history ref and revision of this session. */
  workspace?: { name: string, ref?: string, revision?: string, base?: string }
}

export interface AgentSessionImportOptions {
  /** The Agent the session belongs to. The Console lists it under this name. */
  agentName: string
  /** Your id for the run. Importing the same `agentName` and `runId` again replaces the record. */
  runId: string
  invoker?: { id: string, kind?: string, label?: string }
  /** The session title in the Console. */
  title?: string
  annotations?: Record<string, AgentInvocationAnnotationValue>
  /** Added to the session's recorded configuration, so the Console shows what the agent had. */
  configuration?: AgentSessionConfiguration
  /** The price of the session's usage. The CLIs report none, so the caller prices it, for example from models.dev. */
  cost?: { usd: string, estimated?: boolean, source?: string }
}

export interface AgentSessionImportResult {
  /** The Invocation record id. The Console opens it at `/_vitehub/agents/<agentName>/invocations/<id>`. */
  id: string
  created: boolean
  replaced: boolean
}

type JsonRecord = Record<string, unknown>
interface FileChange { path: string, kind: string, diff: string }
interface PendingTool extends AgentSessionTool { changes?: FileChange[] }

const MAX_CONTENT_LENGTH = 32 * 1024
const MAX_METADATA_LENGTH = 512

function parseLines(text: string): JsonRecord[] {
  const values: JsonRecord[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) values.push(value)
    }
    catch {
      // A session file that is still being written can end in a partial line.
    }
  }
  return values
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  }
  catch {
    return value
  }
}

function partsText(parts: unknown[]): string[] {
  return parts.map(part => string(record(part).text) ?? "")
}

function bounded(value: string, limit = MAX_CONTENT_LENGTH): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n… ${value.length - limit} more characters`
}

function boundedValue(value: unknown): unknown {
  if (typeof value === "string") return bounded(value)
  if (Array.isArray(value)) return value.map(boundedValue)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedValue(item)]))
  return value
}

function relativePath(path: string, cwd: string | undefined): string {
  if (!cwd || !path.startsWith(`${cwd}/`)) return path.replace(/^\/+/, "")
  return path.slice(cwd.length + 1)
}

function addedFileDiff(content: string): string {
  const lines = (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n")
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}\n`
}

/**
 * Codex `apply_patch` text to file changes with unified diff hunks. The patch format has no line numbers, so each hunk
 * starts at line 1. The Console renders only the hunks.
 */
function applyPatchChanges(patch: string, cwd: string | undefined): FileChange[] {
  const changes: { kind: string, path: string, movePath?: string, hunks: string[] }[] = []
  let current: (typeof changes)[number] | undefined
  let hunk: { header: string, lines: string[] } | undefined
  const closeHunk = () => {
    if (!current || !hunk?.lines.length) return
    const oldLines = hunk.lines.filter(line => !line.startsWith("+")).length
    const newLines = hunk.lines.filter(line => !line.startsWith("-")).length
    current.hunks.push(`@@ -${oldLines ? 1 : 0},${oldLines} +${newLines ? 1 : 0},${newLines} @@${hunk.header ? ` ${hunk.header}` : ""}\n${hunk.lines.join("\n")}\n`)
    hunk = undefined
  }
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (file) {
      closeHunk()
      current = { kind: file[1]!.toLowerCase(), path: relativePath(file[2]!.trim(), cwd), hunks: [] }
      changes.push(current)
      continue
    }
    if (!current || line === "*** End Patch" || line === "*** End of File") continue
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move) {
      current.movePath = relativePath(move[1]!.trim(), cwd)
      continue
    }
    if (line.startsWith("@@")) {
      closeHunk()
      hunk = { header: line.replace(/^@@\s*/, ""), lines: [] }
      continue
    }
    if (/^[ +-]/.test(line)) {
      hunk ??= { header: "", lines: [] }
      hunk.lines.push(line)
    }
  }
  closeHunk()
  return changes.map(change => ({ path: change.movePath ?? change.path, kind: change.kind, diff: change.hunks.join("") }))
}

function fileChangeOutput(changes: FileChange[]) {
  return { item: { type: "fileChange", changes } }
}

function emptyUsage(): AgentSessionUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
}

function commandOf(step: AgentSessionTool): string {
  return string(record(step.input).command) ?? ""
}

// Codex

const codexShellTools = new Set(["container.exec", "exec_command", "local_shell", "shell"])

/** Codex command output: a text block with the exit code, or JSON with `output` and `metadata.exit_code`. */
function codexCommandOutput(raw: unknown): { output: string, exitCode?: number, durationMs?: number } {
  const value = parseJson(raw)
  if (isRecord(value)) {
    const metadata = record(value.metadata)
    const seconds = number(metadata.duration_seconds)
    return { output: string(value.output) ?? "", exitCode: number(metadata.exit_code), durationMs: seconds === undefined ? undefined : Math.round(seconds * 1000) }
  }
  const text = string(raw) ?? ""
  const exit = /Process exited with code (-?\d+)/.exec(text)
  const wall = /Wall time: ([\d.]+) seconds/.exec(text)
  const marker = text.indexOf("Output:\n")
  return {
    output: marker === -1 ? text : text.slice(marker + "Output:\n".length),
    exitCode: exit ? Number(exit[1]) : undefined,
    durationMs: wall ? Math.round(Number(wall[1]) * 1000) : undefined,
  }
}

function codexToolCall(name: string, rawArguments: unknown, id: string, timestamp: string, cwd: string | undefined): PendingTool {
  const input = parseJson(rawArguments)
  const args = record(input)
  const command = string(args.cmd) ?? (Array.isArray(args.command) ? args.command.join(" ") : string(args.command))
  if (!codexShellTools.has(name) || command === undefined) return { type: "tool", id, timestamp, name, input }
  const patch = /\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/.exec(command)?.[0]
  const workdir = string(args.workdir) ?? cwd
  return {
    type: "tool",
    id,
    timestamp,
    name: "command_execution",
    input: { command, ...(workdir ? { cwd: workdir } : {}) },
    ...(patch ? { changes: applyPatchChanges(patch, workdir) } : {}),
  }
}

function finishCodexTool(step: PendingTool, raw: unknown, timestamp: string): void {
  step.completedAt = timestamp
  const changes = step.changes
  delete step.changes
  if (step.name === "command_execution") {
    const result = codexCommandOutput(raw)
    step.output = {
      command: commandOf(step),
      output: result.output,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(changes ? fileChangeOutput(changes) : {}),
    }
    if (result.durationMs !== undefined) step.durationMs = result.durationMs
    if (result.exitCode !== undefined && result.exitCode !== 0) step.error = `Exited with code ${result.exitCode}.`
    if (changes) step.kind = "change"
    return
  }
  if (step.name === "apply_patch") {
    step.output = { ...fileChangeOutput(changes ?? []), output: string(raw) ?? "" }
    return
  }
  step.output = parseJson(raw)
}

function codexUsage(info: unknown): AgentSessionUsage | undefined {
  const total = record(info).total_token_usage
  if (!isRecord(total)) return
  return {
    inputTokens: number(total.input_tokens) ?? 0,
    cachedInputTokens: number(total.cached_input_tokens) ?? 0,
    outputTokens: number(total.output_tokens) ?? 0,
    reasoningTokens: number(total.reasoning_output_tokens) ?? 0,
    totalTokens: number(total.total_tokens) ?? 0,
  }
}

/**
 * Read a Codex session file (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 * Developer and context messages are left out. Reasoning appears only when Codex wrote a summary for it
 * (`model_reasoning_summary`); encrypted reasoning has no text to show.
 */
export function readCodexSession(text: string): AgentSession {
  const session: AgentSession = { provider: "codex", status: "completed", steps: [], usage: emptyUsage() }
  const tools = new Map<string, PendingTool>()
  for (const line of parseLines(text)) {
    const payload = record(line.payload)
    const timestamp = string(line.timestamp) ?? session.completedAt ?? new Date(0).toISOString()
    session.startedAt ??= timestamp
    session.completedAt = timestamp
    if (line.type === "session_meta") {
      session.id ??= string(payload.id)
      session.cwd ??= string(payload.cwd)
      session.version ??= string(payload.cli_version)
      continue
    }
    if (line.type === "turn_context") {
      session.model ??= string(payload.model)
      session.reasoningEffort ??= string(payload.effort) ?? string(payload.reasoning_effort)
      continue
    }
    if (line.type === "event_msg") {
      if (payload.type === "user_message") session.prompt ??= string(payload.message)
      else if (payload.type === "token_count") session.usage = codexUsage(payload.info) ?? session.usage
      else if (payload.type === "task_complete") session.text = string(payload.last_agent_message) ?? session.text
      else if (payload.type === "turn_aborted") {
        session.status = "failed"
        session.error = `The turn was aborted${string(payload.reason) ? `: ${payload.reason}` : "."}`
      }
      else if (payload.type === "error") {
        session.status = "failed"
        session.error = string(payload.message) ?? "Codex reported an error."
      }
      continue
    }
    if (line.type !== "response_item") continue
    if (payload.type === "message" && payload.role === "user") {
      // `codex exec` writes no `user_message` event. Codex adds context as user messages that start with a tag.
      const userText = partsText(list(payload.content)).join("")
      if (userText.trim() && !userText.trimStart().startsWith("<")) session.prompt ??= userText
      continue
    }
    if (payload.type === "message" && payload.role === "assistant") {
      const messageText = partsText(list(payload.content)).join("")
      if (!messageText.trim()) continue
      session.steps.push({ type: "message", id: string(payload.id) ?? `message-${session.steps.length}`, timestamp, phase: payload.phase === "final_answer" ? "final" : "commentary", text: messageText })
      continue
    }
    if (payload.type === "reasoning") {
      const reasoning = partsText([...list(payload.summary), ...list(payload.content)]).filter(Boolean).join("\n\n")
      if (reasoning.trim()) session.steps.push({ type: "message", id: string(payload.id) ?? `reasoning-${session.steps.length}`, timestamp, phase: "reasoning", text: reasoning })
      continue
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const id = string(payload.call_id) ?? `tool-${session.steps.length}`
      const name = string(payload.name) ?? "tool"
      let step: PendingTool
      if (payload.type === "function_call") step = codexToolCall(name, payload.arguments, id, timestamp, session.cwd)
      else if (name === "apply_patch" && typeof payload.input === "string") step = { type: "tool", id, timestamp, name, kind: "change", input: { patch: payload.input }, changes: applyPatchChanges(payload.input, session.cwd) }
      else step = { type: "tool", id, timestamp, name, input: payload.input }
      session.steps.push(step)
      tools.set(id, step)
      continue
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const step = tools.get(string(payload.call_id) ?? "")
      if (step) finishCodexTool(step, payload.output, timestamp)
      continue
    }
    if (payload.type === "web_search_call") {
      const action = record(payload.action)
      const query = string(action.query)
      session.steps.push({
        type: "tool",
        id: string(payload.id) ?? `web-search-${session.steps.length}`,
        timestamp,
        completedAt: timestamp,
        name: "web_search",
        title: query ? `Searched the web for ${query}` : "Searched the web",
        input: action,
        output: { status: payload.status },
      })
    }
  }
  // A tool call without output stays pending. Drop the parsed patch so it does not leak into the session shape.
  for (const step of tools.values()) delete step.changes
  session.text ??= session.steps.findLast((step): step is AgentSessionMessage => step.type === "message" && step.phase === "final")?.text
  return session
}

// Claude Code

const claudeFileTools = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"])

function claudeToolResultText(content: unknown): string {
  if (typeof content === "string") return content
  return list(content).map(part => isRecord(part) && part.type === "text" ? string(part.text) ?? "" : "").join("")
}

function structuredPatchDiff(hunks: unknown[]): string {
  return hunks.map((hunk) => {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return ""
    return `@@ -${number(hunk.oldStart) ?? 0},${number(hunk.oldLines) ?? 0} +${number(hunk.newStart) ?? 0},${number(hunk.newLines) ?? 0} @@\n${hunk.lines.join("\n")}\n`
  }).join("")
}

function claudeToolCall(block: JsonRecord, timestamp: string, cwd: string | undefined): AgentSessionTool {
  const input = record(block.input)
  const name = string(block.name) ?? "tool"
  const step: AgentSessionTool = { type: "tool", id: string(block.id) ?? `tool-${timestamp}`, timestamp, name, input }
  if (name === "Bash") {
    step.input = { command: string(input.command) ?? "", ...(cwd ? { cwd } : {}) }
    step.title = string(input.description)
  }
  else if (claudeFileTools.has(name)) {
    step.kind = "change"
  }
  const filePath = string(input.file_path)
  if (filePath) step.title ??= `${name} ${relativePath(filePath, cwd)}`
  return step
}

function finishClaudeTool(step: AgentSessionTool, block: JsonRecord, result: unknown, timestamp: string, cwd: string | undefined): void {
  step.completedAt = timestamp
  const text = claudeToolResultText(block.content)
  if (block.is_error === true) step.error = text || "The tool failed."
  if (step.name === "Bash") {
    const output = isRecord(result) ? [string(result.stdout), string(result.stderr)].filter(Boolean).join("\n") : text
    step.output = { command: commandOf(step), output: output || text }
    return
  }
  if (step.kind === "change") {
    const input = record(step.input)
    const details = record(result)
    const path = string(input.file_path) ?? string(details.filePath) ?? ""
    const patch = list(details.structuredPatch)
    const created = details.type === "create"
    let diff = ""
    if (patch.length) diff = structuredPatchDiff(patch)
    else if (created && typeof details.content === "string") diff = addedFileDiff(details.content)
    else if (step.name === "Write" && typeof input.content === "string") diff = addedFileDiff(input.content)
    step.output = { ...fileChangeOutput([{ path: relativePath(path, cwd), kind: created ? "add" : "update", diff }]), output: text }
    return
  }
  step.output = text || result
}

/**
 * Read a Claude Code session file (`$CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl`).
 * Thinking blocks become reasoning steps. Subagent (sidechain) lines are left out.
 */
export function readClaudeCodeSession(text: string): AgentSession {
  const session: AgentSession = { provider: "claude-code", status: "completed", steps: [], usage: emptyUsage() }
  const tools = new Map<string, AgentSessionTool>()
  // Claude Code writes one line per content block, and each repeats the message usage. Count each message once.
  const usageByMessage = new Map<string, JsonRecord>()
  for (const line of parseLines(text)) {
    if (line.isSidechain === true || (line.type !== "user" && line.type !== "assistant")) continue
    const timestamp = string(line.timestamp) ?? session.completedAt ?? new Date(0).toISOString()
    session.startedAt ??= timestamp
    session.completedAt = timestamp
    session.id ??= string(line.sessionId)
    session.cwd ??= string(line.cwd)
    session.version ??= string(line.version)
    const message = record(line.message)
    const content = message.content
    if (line.type === "user") {
      if (line.isMeta === true) continue
      if (typeof content === "string") {
        session.prompt ??= content
        continue
      }
      for (const block of list(content)) {
        if (!isRecord(block)) continue
        if (block.type === "text") session.prompt ??= string(block.text)
        if (block.type === "tool_result") {
          const step = tools.get(string(block.tool_use_id) ?? "")
          if (step) finishClaudeTool(step, block, line.toolUseResult, timestamp, session.cwd)
        }
      }
      continue
    }
    session.model ??= string(message.model)
    const messageId = string(message.id)
    if (messageId && isRecord(message.usage)) usageByMessage.set(messageId, message.usage)
    if (message.stop_reason === "refusal") {
      session.status = "failed"
      session.error = "The model refused."
    }
    for (const block of list(content)) {
      if (!isRecord(block)) continue
      const thinking = string(block.thinking)
      const blockText = string(block.text)
      if (block.type === "thinking" && thinking?.trim()) session.steps.push({ type: "message", id: `${messageId ?? "thinking"}:${session.steps.length}`, timestamp, phase: "reasoning", text: thinking })
      else if (block.type === "text" && blockText?.trim()) session.steps.push({ type: "message", id: `${messageId ?? "text"}:${session.steps.length}`, timestamp, phase: "commentary", text: blockText })
      else if (block.type === "tool_use") {
        const step = claudeToolCall(block, timestamp, session.cwd)
        session.steps.push(step)
        tools.set(step.id, step)
      }
    }
  }
  for (const usage of usageByMessage.values()) {
    const cacheRead = number(usage.cache_read_input_tokens) ?? 0
    const input = (number(usage.input_tokens) ?? 0) + cacheRead + (number(usage.cache_creation_input_tokens) ?? 0)
    const output = number(usage.output_tokens) ?? 0
    session.usage.inputTokens += input
    session.usage.cachedInputTokens += cacheRead
    session.usage.outputTokens += output
    session.usage.totalTokens += input + output
  }
  // Claude Code does not mark the answer. The last assistant text is the answer.
  const final = session.steps.findLast((step): step is AgentSessionMessage => step.type === "message" && step.phase === "commentary")
  if (final) {
    final.phase = "final"
    session.text = final.text
  }
  return session
}

/** Read a session file of a known provider. */
export function readAgentSession(provider: AgentSessionProvider, text: string): AgentSession {
  if (provider === "codex") return readCodexSession(text)
  if (provider === "claude-code") return readClaudeCodeSession(text)
  throw agentDiagnostics.AGENT_R1040({ provider })
}

// Invocation

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return `sha256_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`
}

function durationMs(from: string, to: string): number | undefined {
  const value = Date.parse(to) - Date.parse(from)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The finished Agent Invocation record of a session, with the session's own timestamps. The id is the one ViteHub
 * gives a run of `agentName` with `runId` (`agentInvocationId(runId, agentName)`), so
 * `/_vitehub/agents/<agentName>/invocations/<id>` opens it in the Console.
 */
export async function agentSessionInvocation(session: AgentSession, options: AgentSessionImportOptions): Promise<AgentInvocationStoreCreateInput> {
  const { agentName, runId } = options
  if (!agentName?.trim() || !runId?.trim()) throw agentDiagnostics.AGENT_R1041()
  const id = await agentInvocationId(runId, agentName)
  const traceId = await sha256(JSON.stringify(["trace", agentName, runId]))
  const startedAt = session.startedAt ?? new Date().toISOString()
  const completedAt = session.completedAt ?? startedAt
  const invoker = options.invoker ?? { id: "import", kind: "import", label: "Imported session" }
  const ids = { "agent.invocation.id": runId, "agent.run.id": runId }
  const invokerAttributes = { "agent.invoker.id": invoker.id, "agent.invoker.kind": invoker.kind ?? "import", "agent.invoker.label": invoker.label ?? invoker.id }
  const observations: TraceEventLogEntry[] = []
  const add = (name: string, timestamp: string, attributes: Record<string, unknown>, owner: "agent" | "vitehub" = "agent", type: "error" | "run" = "run") => {
    const phase = owner === "vitehub" ? "setup" : "execution"
    observations.push({
      name,
      type,
      trace: { id: traceId },
      activity: { owner, phase },
      attributes: { ...ids, ...attributes, "vitehub.activity.owner": owner, "vitehub.activity.phase": phase },
      sequence: observations.length + 1,
      timestamp,
    })
  }

  const extra = options.configuration ?? {}
  const configuration = {
    agent: { name: agentName },
    capabilities: [],
    driver: {
      kind: session.provider,
      provider: session.provider,
      ...(session.model ? { model: { id: session.model, provider: session.provider } } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.version ? { version: session.version } : {}),
    },
    runtime: { name: "import" },
    ...(extra.skills ? { skills: extra.skills.slice(0, 200) } : {}),
    ...(extra.mcpServers ? { mcpServers: extra.mcpServers.slice(0, 50) } : {}),
    ...(extra.tools ? { tools: extra.tools.slice(0, 200) } : {}),
    ...(extra.workspace ? { workspace: extra.workspace } : {}),
  }
  const fingerprint = await sha256(JSON.stringify(configuration))
  add("vitehub.agent.configured", startedAt, { "vitehub.agent.configuration": { ...configuration, fingerprint }, "vitehub.agent.configuration.fingerprint": fingerprint }, "vitehub")
  add("agent.invocation.start", startedAt, {
    ...invokerAttributes,
    "runtime.name": "import",
    "input.hasPrompt": Boolean(session.prompt),
    ...(session.prompt ? { "input.prompt": bounded(session.prompt), "input.prompt.truncated": session.prompt.length > MAX_CONTENT_LENGTH } : {}),
    "session.provider": session.provider,
    ...(session.id ? { "session.id": session.id } : {}),
  })
  const title = options.title?.trim().slice(0, MAX_METADATA_LENGTH)
  if (title) add("agent.title.recorded", startedAt, { "vitehub.session.title": title })

  for (const step of session.steps) {
    if (step.type === "message") {
      add("agent.message.delta", step.timestamp, { "message.id": step.id, "message.phase": step.phase, "message.role": "assistant", "message.content": bounded(step.text) })
      continue
    }
    const tool = {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.id": step.id,
      "gen_ai.tool.name": step.name,
      "step.id": step.id,
      "tool.id": step.id,
      "tool.name": step.name,
      "vitehub.activity.kind": step.kind ?? "tool",
      ...(step.title ? { "tool.title": bounded(step.title, MAX_METADATA_LENGTH) } : {}),
    }
    add("agent.tool.start", step.timestamp, { ...tool, "tool.hasInput": step.input !== undefined, ...(step.input === undefined ? {} : { "tool.input": boundedValue(step.input) }) })
    const finishedAt = step.completedAt ?? step.timestamp
    add("agent.tool.finish", finishedAt, {
      ...tool,
      "tool.durationMs": step.durationMs ?? durationMs(step.timestamp, finishedAt) ?? 0,
      "tool.hasOutput": step.output !== undefined,
      ...(step.output === undefined ? {} : { "tool.output": boundedValue(step.output) }),
      ...(step.error ? { "tool.error": bounded(step.error) } : {}),
    })
  }

  const usage = session.usage
  const estimated = options.cost?.estimated ?? true
  const cost = options.cost
    ? { usd: options.cost.usd, estimated, source: options.cost.source ?? "custom", display: `${estimated ? "~" : ""}$${options.cost.usd}` }
    : undefined
  const totalTokens = usage.totalTokens || usage.inputTokens + usage.outputTokens
  const usageRecord = {
    model: session.model ?? "unknown",
    provider: session.provider,
    ...(cost ? { cost } : {}),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens,
      inputTokenDetails: { cacheReadTokens: usage.cachedInputTokens },
      outputTokenDetails: { reasoningTokens: usage.reasoningTokens },
    },
  }
  add("agent.usage.recorded", completedAt, {
    "usage.model": usageRecord.model,
    "usage.provider": session.provider,
    "usage.inputTokens": usage.inputTokens,
    "usage.cachedInputTokens": usage.cachedInputTokens,
    "usage.outputTokens": usage.outputTokens,
    "usage.reasoningTokens": usage.reasoningTokens,
    "usage.totalTokens": totalTokens,
    "usage.hasCost": Boolean(cost),
    ...(cost ? { "usage.costUsd": cost.usd, "usage.costEstimated": cost.estimated, "usage.costSource": cost.source } : {}),
    "usage.hasRaw": false,
  })

  const failed = session.status === "failed"
  add("agent.stream.finish", completedAt, { "finish.reason": failed ? "error" : "completed" })
  add(failed ? "agent.invocation.error" : "agent.invocation.finish", completedAt, {
    ...invokerAttributes,
    "runtime.name": "import",
    "input.hasPrompt": Boolean(session.prompt),
    "invocation.durationMs": durationMs(startedAt, completedAt) ?? 0,
    "usage.record": usageRecord,
    ...(failed
      ? { "error.message": session.error ?? "The session failed." }
      : { "result.hasValue": Boolean(session.text), "result.kind": "text", ...(session.text ? { "result.text": bounded(session.text) } : {}) }),
  }, "agent", failed ? "error" : "run")

  const titleSequence = observations.find(observation => observation.name === "agent.title.recorded")?.sequence
  return {
    id,
    agentName,
    traceId,
    status: failed ? "failed" : "completed",
    createdAt: startedAt,
    startedAt,
    updatedAt: completedAt,
    ...(failed ? { failedAt: completedAt } : { completedAt }),
    ...(title ? { title, titleSequence } : {}),
    ...(options.annotations ? { annotations: options.annotations } : {}),
    observations,
  }
}

/**
 * Write a session to an Agent Invocation store as a finished Invocation. Importing the same `agentName` and `runId`
 * again replaces the earlier record, so the store must implement `delete()`.
 */
export async function importAgentSession(store: AgentInvocationStore, session: AgentSession, options: AgentSessionImportOptions): Promise<AgentSessionImportResult> {
  const record = await agentSessionInvocation(session, options)
  await store.open?.()
  const existing = await store.getSummary(record.id)
  if (existing) {
    if (!store.delete) throw agentDiagnostics.AGENT_R1042()
    const outcome = await store.delete(record.id)
    if (outcome === "not-terminal") throw agentDiagnostics.AGENT_R1043({ id: record.id })
  }
  const { created } = await store.create(record)
  return { id: record.id, created, replaced: Boolean(existing) }
}
