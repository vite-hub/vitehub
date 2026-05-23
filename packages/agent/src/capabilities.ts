import {
  defineCapability,
  normalizeMode,
} from "./capability-runtime.ts"
import {
  getMessageText,
  validateMessage,
} from "./messages.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentCapabilityMode,
  AgentRunInput,
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
} from "./types.ts"
import type { Message } from "./messages.ts"

function primitiveHandle(context: AgentCapabilityContext, name: string): unknown {
  const handle = context.capabilities?.[name] as { value?: unknown } | unknown
  return typeof handle === "object" && handle !== null && "value" in handle
    ? (handle as { value?: unknown }).value
    : handle
}

function requirePrimitive(context: AgentCapabilityContext, name: string): unknown {
  const handle = primitiveHandle(context, name)
  if (!handle) throw new Error(`[vitehub] Capability "${name}" requires the ${name} primitive to be configured.`)
  return handle
}

function defineInternalTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolDefinition<TInput, TOutput>,
): AgentToolDefinition<TInput, TOutput> {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("[vitehub] tool definitions must be objects.")
  }
  if (!tool.name || typeof tool.name !== "string") {
    throw new TypeError("[vitehub] tool definitions require a tool name.")
  }
  return tool
}

function primitiveMethodTool(primitive: "blob" | "db" | "kv", method: string, handle: unknown): AgentToolDefinition {
  return defineInternalTool({
    description: `Call ${primitive}.${method}.`,
    name: `${primitive}_${method}`,
    async execute(input) {
      const primitiveHandle = handle as Record<string, unknown>
      const fn = primitiveHandle[method]
      if (typeof fn !== "function") throw new Error(`[vitehub] ${primitive} primitive does not expose ${method}().`)
      const args = Array.isArray(input) ? input : [input]
      return await fn.apply(primitiveHandle, args)
    },
  })
}

function primitiveTools(primitive: "blob" | "db" | "kv", mode: AgentCapabilityMode): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const handle = requirePrimitive(context as never, primitive)
    if (primitive === "kv") {
      return {
        kv_get: primitiveMethodTool("kv", "get", handle),
        kv_keys: primitiveMethodTool("kv", "keys", handle),
        ...(mode === "write"
          ? {
              kv_del: primitiveMethodTool("kv", "del", handle),
              kv_set: primitiveMethodTool("kv", "set", handle),
            }
          : {}),
      }
    }
    if (primitive === "blob") {
      return {
        blob_get: primitiveMethodTool("blob", "get", handle),
        blob_head: primitiveMethodTool("blob", "head", handle),
        blob_list: primitiveMethodTool("blob", "list", handle),
        ...(mode === "write"
          ? {
              blob_del: primitiveMethodTool("blob", "del", handle),
              blob_put: primitiveMethodTool("blob", "put", handle),
            }
          : {}),
      }
    }
    return {
      db_query: primitiveMethodTool("db", "query", handle),
      db_schema: primitiveMethodTool("db", "schema", handle),
      ...(mode === "write" ? { db_execute: primitiveMethodTool("db", "execute", handle) } : {}),
    }
  }
}

function validateSandboxCommands(commands: unknown): string[] {
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError("[vitehub] sandbox({ commands }) requires at least one executable name.")
  }
  for (const command of commands) {
    if (typeof command !== "string" || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw new TypeError("[vitehub] sandbox({ commands }) accepts executable names only, not shell command strings.")
    }
  }
  return commands
}

export interface InputCommand {
  description: string
  run: (input: InputCommandRunInput) => MaybePromise<Partial<AgentRunInput> | string | void>
}

export interface InputCommandRunInput {
  args: string
  command: InputCommand
  context: AgentCapabilityRuntimeContext
  input: AgentRunInput
  message?: Message
  name: string
  text: string
}

export interface InputCommandsOptions {
  commands: Record<string, InputCommand>
  id?: string
  trigger?: string
}

interface InputCommandInvocation {
  args: string
  end: number
  name: string
  start: number
  text: string
}

interface InputCommandTarget {
  message?: Message
  messageIndex?: number
  messages?: Message[]
  text: string
  type: "message" | "prompt"
}

interface InputCommandTextReplacement {
  end: number
  replacement: string
  start: number
}

function assertInputCommandName(name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new TypeError(`[vitehub] Input command "${name}" must be a lowercase stable identifier.`)
  }
}

function normalizeInputCommands(options: InputCommandsOptions): Record<string, InputCommand> {
  if (!options || typeof options !== "object" || !options.commands || typeof options.commands !== "object" || Array.isArray(options.commands)) {
    throw new TypeError("[vitehub] inputCommands({ commands }) requires a command map.")
  }
  for (const [name, command] of Object.entries(options.commands)) {
    assertInputCommandName(name)
    if (!command || typeof command !== "object") {
      throw new TypeError(`[vitehub] Input command "${name}" must be an object.`)
    }
    if (typeof command.description !== "string" || !command.description.trim()) {
      throw new TypeError(`[vitehub] Input command "${name}" requires a description.`)
    }
    if (typeof command.run !== "function") {
      throw new TypeError(`[vitehub] Input command "${name}" requires a run() handler.`)
    }
  }
  return options.commands
}

function normalizeInputCommandTrigger(trigger: unknown): string {
  if (trigger === undefined) return "/"
  if (typeof trigger !== "string" || !trigger) {
    throw new TypeError("[vitehub] inputCommands({ trigger }) must be a non-empty string.")
  }
  if (/\s/.test(trigger)) {
    throw new TypeError("[vitehub] inputCommands({ trigger }) must not contain whitespace.")
  }
  return trigger
}

function isInputCommandBoundary(value: string | undefined): boolean {
  return value === undefined || /\s/.test(value)
}

function trimEndIndex(text: string, start: number, end: number): number {
  let index = end
  while (index > start && /\s/.test(text[index - 1]!)) index--
  return index
}

function findInputCommandInvocation(
  text: string,
  trigger: string,
  commands: Record<string, InputCommand>,
  from = 0,
): InputCommandInvocation | undefined {
  let current: { afterName: number, name: string, start: number } | undefined
  for (let index = Math.max(0, from); index < text.length; index++) {
    if (!text.startsWith(trigger, index) || !isInputCommandBoundary(text[index - 1])) continue
    const nameStart = index + trigger.length
    const match = /^[a-z][a-z0-9_-]*/.exec(text.slice(nameStart))
    if (!match) continue
    const name = match[0]
    if (!commands[name]) continue
    const afterName = nameStart + name.length
    if (!isInputCommandBoundary(text[afterName])) continue

    if (current) {
      const end = trimEndIndex(text, current.start, index)
      const args = text.slice(current.afterName, end).trim()
      return {
        args,
        end,
        name: current.name,
        start: current.start,
        text: text.slice(current.start, end),
      }
    }

    current = { afterName, name, start: index }
    index = afterName - 1
  }

  if (current) {
    const args = text.slice(current.afterName).trim()
    return {
      args,
      end: text.length,
      name: current.name,
      start: current.start,
      text: text.slice(current.start),
    }
  }
}

function latestUserMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}

function getInputCommandTarget(input: AgentRunInput): InputCommandTarget | undefined {
  if (typeof input.prompt === "string" && !input.messages) {
    return { text: input.prompt, type: "prompt" }
  }

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : undefined)
  if (!messages) return
  const messageIndex = latestUserMessageIndex(messages)
  if (messageIndex < 0) return
  const message = messages[messageIndex]!
  return {
    message,
    messageIndex,
    messages,
    text: getMessageText(message),
    type: "message",
  }
}

function replaceMessageTextParts(message: Message, replacement: InputCommandTextReplacement): Message {
  let offset = 0
  let inserted = false
  let touched = false
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "text") return part

      const partStart = offset
      const partEnd = partStart + part.text.length
      offset = partEnd
      if (partEnd <= replacement.start || partStart >= replacement.end) return part

      touched = true
      const before = replacement.start > partStart ? part.text.slice(0, replacement.start - partStart) : ""
      const after = replacement.end < partEnd ? part.text.slice(replacement.end - partStart) : ""
      const text = `${before}${inserted ? "" : replacement.replacement}${after}`
      inserted = true
      return { ...part, text }
    }).concat(touched ? [] : [{ id: "text-0", text: replacement.replacement, type: "text" }]),
  }
}

function replaceTargetText(
  input: AgentRunInput,
  target: InputCommandTarget,
  text: string,
  replacement?: InputCommandTextReplacement,
): AgentRunInput {
  if (target.type === "prompt") return { ...input, prompt: text }

  const nextMessage: Message = replacement
    ? replaceMessageTextParts(target.message!, replacement)
    : { ...target.message!, parts: [{ id: "text-0", text, type: "text" }, ...target.message!.parts.filter(part => part.type !== "text")] }
  validateMessage(nextMessage)
  const messages = [...(target.messages || [])]
  messages[target.messageIndex!] = nextMessage
  if (!input.messages) return { ...input, prompt: messages }
  const next = { ...input, messages }
  if (typeof next.prompt === "string") delete next.prompt
  return next
}

function mergeInputCommandResult(input: AgentRunInput, result: Partial<AgentRunInput>): AgentRunInput {
  const next: AgentRunInput = {
    ...input,
    ...result,
    context: result.context
      ? { ...input.context, ...result.context }
      : input.context,
  }
  if (result.messages !== undefined && result.prompt === undefined) {
    delete next.prompt
  }
  if (result.prompt !== undefined && result.messages === undefined) {
    delete next.messages
  }
  return next
}

export function inputCommands(options: InputCommandsOptions): AgentCapabilityDefinition {
  const commands = normalizeInputCommands(options)
  const trigger = normalizeInputCommandTrigger(options.trigger)
  return defineCapability({
    id: options.id || "inputCommands",
    metadata: {
      commands: Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, { description: command.description }])),
      trigger,
    },
    input: async (context) => {
      let input = context.input.get()
      let target = getInputCommandTarget(input)
      if (!target) return

      let text = target.text
      let cursor = 0
      let runs = 0
      let maxRuns = Math.max(1_000, text.length + 1)
      while (cursor <= text.length) {
        const invocation = findInputCommandInvocation(text, trigger, commands, cursor)
        if (!invocation) break
        if (++runs > maxRuns) throw new Error("[vitehub] inputCommands exceeded the maximum command expansion depth.")

        const command = commands[invocation.name]!
        const result = await command.run({
          args: invocation.args,
          command,
          context: context as AgentCapabilityRuntimeContext,
          input,
          message: target.message,
          name: invocation.name,
          text: invocation.text,
        })

        const previousText = text
        input = context.input.get()
        target = getInputCommandTarget(input)
        if (!target) return
        text = target.text
        maxRuns = Math.max(maxRuns, text.length + 1)

        if (typeof result === "string") {
          if (text.slice(invocation.start, invocation.end) !== invocation.text) {
            cursor = text === previousText ? invocation.end : 0
            continue
          }
          text = `${text.slice(0, invocation.start)}${result}${text.slice(invocation.end)}`
          input = replaceTargetText(input, target, text, {
            end: invocation.end,
            replacement: result,
            start: invocation.start,
          })
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          maxRuns = Math.max(maxRuns, text.length + 1)
          cursor = result === invocation.text ? invocation.end : invocation.start
          continue
        }

        if (result && typeof result === "object") {
          input = mergeInputCommandResult(input, result)
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          text = target.text
          maxRuns = Math.max(maxRuns, text.length + 1)
          if (text !== previousText) {
            cursor = 0
            continue
          }
        }

        if (text !== previousText) {
          cursor = 0
          continue
        }
        cursor = invocation.end
      }
    },
  })
}

export function bash(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Bash")
  return defineCapability({
    id: "bash",
    mode,
    requires: [{ primitive: "workspace", workspace: { mode, required: true } }],
    tools: ({ workspace }) => (mode === "write" && "write" in workspace.tools
      ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
      : workspace.tools.inspect()) as AgentToolSet,
  })
}

export function sandbox(options: { commands: string[] }): AgentCapabilityDefinition {
  const commands = validateSandboxCommands(options?.commands)
  return defineCapability({
    id: "sandbox",
    metadata: { commands },
    requires: [{ primitive: "workspace", workspace: { required: true } }, { primitive: "sandbox" }],
    tools: (context) => {
      const handle = requirePrimitive(context as never, "sandbox") as {
        exec?: (command: string, args?: string[], options?: unknown) => MaybePromise<unknown>
      }
      return {
        sandbox_exec: defineInternalTool({
          description: `Run one allowed executable in an isolated sandbox. Allowed commands: ${commands.join(", ")}.`,
          name: "sandbox_exec",
          async execute(input) {
            const value = input as { args?: string[], command?: string, cwd?: string, env?: Record<string, string>, timeout?: number }
            if (!value || typeof value.command !== "string") throw new TypeError("[vitehub] sandbox_exec requires a command.")
            if (!commands.includes(value.command)) throw new Error(`[vitehub] Sandbox command "${value.command}" is not allowed.`)
            if (!handle.exec) throw new Error("[vitehub] Sandbox primitive does not expose exec().")
            return await handle.exec(value.command, value.args || [], { cwd: value.cwd, env: value.env, timeout: value.timeout })
          },
        }),
      }
    },
  })
}

export function kv(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "KV")
  return defineCapability({ id: "kv", mode, requires: [{ primitive: "kv" }], tools: primitiveTools("kv", mode) })
}

export function blob(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Blob")
  return defineCapability({ id: "blob", mode, requires: [{ primitive: "blob" }], tools: primitiveTools("blob", mode) })
}

export function db(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "DB")
  return defineCapability({ id: "db", mode, requires: [{ primitive: "db" }], tools: primitiveTools("db", mode) })
}

export function skills(options: { path?: string } = {}): AgentCapabilityDefinition {
  const path = options.path || "skills"
  const skillPath = path.replace(/\/+$/, "").endsWith("/SKILL.md")
    ? path.replace(/\/+$/, "")
    : `${path.replace(/\/+$/, "")}/SKILL.md`
  return defineCapability({
    id: "skills",
    metadata: { path: path.replace(/\/+$/, ""), skillPath },
    requires: [{ primitive: "workspace", workspace: { mode: "read", paths: [skillPath], required: true } }],
  })
}

export function mcp(options: { servers?: Record<string, unknown> } = {}): AgentCapabilityDefinition {
  return defineCapability({
    id: "mcp",
    metadata: { servers: options.servers || {} },
  })
}

export {
  memory,
  workspaceJsonlMemoryStore,
} from "./memory.ts"
export {
  normalizeAgentUsage,
  staticModelPricing,
  usageTelemetry,
  vercelAiGatewayPricing,
} from "./capabilities/usage-telemetry.ts"

export type {
  MemoryAppendRequest,
  MemoryCapabilityInstructionsOption,
  MemoryCapabilityOptions,
  MemoryDeleteRequest,
  MemoryExportRequest,
  MemoryKind,
  MemoryProvenance,
  MemoryReadRequest,
  MemoryRecord,
  MemoryScope,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStoreAdapter,
  MemoryStoreFactory,
  MemoryStoreOptions,
  WorkspaceJsonlMemoryStoreOptions,
} from "./memory.ts"
export type {
  AgentUsagePricing,
  AgentUsagePricingContext,
  StaticModelPrice,
  UsageTelemetryOptions,
  VercelAiGatewayPricingOptions,
} from "./capabilities/usage-telemetry.ts"
