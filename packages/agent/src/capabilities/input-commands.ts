import { defineCapability } from "../capability-runtime.ts"
import {
  getMessageText,
  validateMessage,
} from "../messages.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRunInput,
  MaybePromise,
} from "../types.ts"
import type { Message } from "../messages.ts"

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

export interface InputCommandInvocation {
  args: string
  end: number
  name: string
  start: number
  text: string
}

export interface InputCommandTarget {
  message?: Message
  messageIndex?: number
  messages?: Message[]
  text: string
  type: "message" | "prompt"
}

export interface InputCommandTextReplacement {
  end: number
  replacement: string
  start: number
}

export interface GitHubPullRequestCommand {
  action: "created"
  actor: {
    association?: string
    id?: number
    login: string
    type?: string
  }
  args: string
  command: string
  commentId: number
  commentNodeId?: string
  deliveryId?: string
  installationId?: number
  issueNumber: number
  owner: string
  pullRequestUrl: string
  repo: string
  repository: string
}

export interface GitHubPullRequestRunContextOptions {
  origin?: string
  runId?: string
  sourceMount?: string
  sourceRef?: string
  threadId?: string
}

export interface GitHubPullRequestRunContext {
  pullRequest: {
    apiUrl: string
    number: number
    source: {
      mount: string
      ref: string
      repo: string
    }
  }
  repository: {
    fullName: string
    name: string
    owner: string
  }
  run: {
    messageId: string
    origin: string
    runId: string
    threadId: string
  }
  trigger: {
    action: GitHubPullRequestCommand["action"]
    actor: GitHubPullRequestCommand["actor"]
    args: string
    command: string
    comment: {
      id: number
      nodeId?: string
    }
    deliveryId?: string
    installationId?: number
  }
}

export interface GitHubPullRequestInputCommandRunInput extends InputCommandRunInput {
  github: GitHubPullRequestCommand
  pullRequest: GitHubPullRequestRunContext
}

export interface GitHubPullRequestInputCommandOptions {
  description: string
  run?: (input: GitHubPullRequestInputCommandRunInput) => MaybePromise<Partial<AgentRunInput> | string | void>
  runContext?: GitHubPullRequestRunContextOptions | ((input: InputCommandRunInput & { github: GitHubPullRequestCommand }) => MaybePromise<GitHubPullRequestRunContextOptions>)
}

type GitHubIssueCommentPayload = {
  action?: unknown
  comment?: {
    author_association?: unknown
    body?: unknown
    id?: unknown
    node_id?: unknown
    user?: { id?: unknown, login?: unknown, type?: unknown }
  }
  installation?: { id?: unknown }
  issue?: {
    author_association?: unknown
    number?: unknown
    pull_request?: { url?: unknown }
  }
  repository?: {
    full_name?: unknown
    name?: unknown
    owner?: { login?: unknown }
  }
}

export function assertInputCommandName(name: string): void {
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

export function normalizeInputCommandTrigger(trigger: unknown): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function inputPayload(input: unknown): GitHubIssueCommentPayload | undefined {
  if (!isRecord(input)) return
  return isRecord(input.payload) ? input.payload as GitHubIssueCommentPayload : undefined
}

function inputGithubFacts(input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return
  return isRecord(input.github) ? input.github : undefined
}

function githubPullRequestCommandFromInput(
  input: AgentRunInput,
  name: string,
  args: string,
  text: string,
): GitHubPullRequestCommand | undefined {
  const delivery = isRecord(input.context) ? input.context.github : undefined
  const payload = inputPayload(delivery)
  const facts = inputGithubFacts(delivery)
  if (!payload || facts?.event !== "issue_comment" || payload.action !== "created") return
  if (!payload.issue?.pull_request) return
  const repository = maybeString(payload.repository?.full_name)
  const [owner, repo] = repository?.split("/") || []
  const login = maybeString(payload.comment?.user?.login)
  const issueNumber = maybeNumber(payload.issue?.number)
  const commentId = maybeNumber(payload.comment?.id)
  const pullRequestUrl = maybeString(payload.issue.pull_request.url)
  if (!repository || !owner || !repo || !login || !issueNumber || !commentId || !pullRequestUrl) return
  const association = maybeString(payload.comment?.author_association) || maybeString(payload.issue.author_association)
  return {
    action: "created",
    actor: {
      ...(association ? { association } : {}),
      ...(maybeNumber(payload.comment?.user?.id) ? { id: maybeNumber(payload.comment?.user?.id) } : {}),
      login,
      ...(maybeString(payload.comment?.user?.type) ? { type: maybeString(payload.comment?.user?.type) } : {}),
    },
    args,
    command: text.trim().split(/\s+/, 1)[0] || `/${name}`,
    commentId,
    ...(maybeString(payload.comment?.node_id) ? { commentNodeId: maybeString(payload.comment?.node_id) } : {}),
    ...(maybeString(facts?.deliveryId) ? { deliveryId: maybeString(facts?.deliveryId) } : {}),
    ...(maybeNumber(facts?.installationId) ? { installationId: maybeNumber(facts?.installationId) } : {}),
    issueNumber,
    owner,
    pullRequestUrl,
    repo,
    repository,
  }
}

function mergeGithubCommandContext(
  input: GitHubPullRequestInputCommandRunInput,
): void {
  const current = input.context.input.get()
  input.context.input.set({
    ...current,
    context: {
      ...current.context,
      github: input.github,
      pullRequest: input.pullRequest,
    },
  })
}

export function findInputCommandInvocation(
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

export function getInputCommandTarget(input: AgentRunInput): InputCommandTarget | undefined {
  if (typeof input.prompt === "string" && !input.messages) {
    return { text: input.prompt, type: "prompt" }
  }

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : undefined)
  if (!messages) return
  const messageIndex = latestUserMessageIndex(messages)
  if (messageIndex < 0) {
    return typeof input.prompt === "string"
      ? { text: input.prompt, type: "prompt" }
      : undefined
  }
  const message = messages[messageIndex]!
  return {
    message,
    messageIndex,
    messages,
    text: getMessageText(message),
    type: "message",
  }
}

export function replaceMessageTextParts(message: Message, replacement: InputCommandTextReplacement): Message {
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

export function replaceTargetText(
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

export function githubPullRequestRunContext(
  command: GitHubPullRequestCommand,
  options: GitHubPullRequestRunContextOptions = {},
): GitHubPullRequestRunContext {
  const runId = options.runId || command.deliveryId || `github:${command.repository}#${command.issueNumber}:comment:${command.commentId}`
  return {
    pullRequest: {
      apiUrl: command.pullRequestUrl,
      number: command.issueNumber,
      source: {
        mount: options.sourceMount || command.repo,
        ref: options.sourceRef || `refs/pull/${command.issueNumber}/head`,
        repo: command.repository,
      },
    },
    repository: {
      fullName: command.repository,
      name: command.repo,
      owner: command.owner,
    },
    run: {
      messageId: String(command.commentId),
      origin: options.origin || "github-pull-request",
      runId,
      threadId: options.threadId || command.pullRequestUrl,
    },
    trigger: {
      action: command.action,
      actor: command.actor,
      args: command.args,
      command: command.command,
      comment: {
        id: command.commentId,
        ...(command.commentNodeId ? { nodeId: command.commentNodeId } : {}),
      },
      ...(command.deliveryId ? { deliveryId: command.deliveryId } : {}),
      ...(command.installationId ? { installationId: command.installationId } : {}),
    },
  }
}

export function githubPullRequestCommand(options: GitHubPullRequestInputCommandOptions): InputCommand {
  if (!options || typeof options !== "object") {
    throw new TypeError("[vitehub] githubPullRequestCommand() requires options.")
  }
  if (typeof options.description !== "string" || !options.description.trim()) {
    throw new TypeError("[vitehub] githubPullRequestCommand({ description }) is required.")
  }
  return {
    description: options.description,
    async run(input) {
      const command = githubPullRequestCommandFromInput(input.input, input.name, input.args, input.text)
      if (!command) return
      const runContextOptions = typeof options.runContext === "function"
        ? await options.runContext({ ...input, github: command })
        : options.runContext
      const pullRequest = githubPullRequestRunContext(command, runContextOptions)
      const commandInput = { ...input, github: command, pullRequest }
      mergeGithubCommandContext(commandInput)
      return await options.run?.(commandInput)
    },
  }
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
