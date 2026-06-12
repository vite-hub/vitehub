import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { setWorkspaceRuntimeRegistry } from "@vite-hub/workspace/internal/runtime/state"

import {
  createAgentDevtoolsMetadata,
  resolveAgentDevtoolsMetadata,
  resolveAgentTriggers,
  streamAgentTrigger,
  withWorkspaceAgentDefaults,
} from "../../index.ts"
import {
  type ChatDevtoolsConversation,
  type ChatDevtoolsMetadata,
  type ChatDevtoolsMetadataStatus,
  type ChatDevtoolsStateResult,
  type ChatDevtoolsStreamEvent,
  chatDevtoolsBridgeRoute,
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsSendRpc,
} from "../devtools.ts"
import { createAgentRuntimeContext } from "../../runtime/context.ts"
import { discoverAgentDefinitions } from "../../discovery.ts"

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import type { UIMessage } from "ai"
import type { ViteDevServer } from "vite"
import type { AgentChatMessageTriggerInput } from "../../chat-trigger.ts"
import type {
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  DiscoveredAgentDefinition,
  WorkspaceAgentDefaults,
} from "../../index.ts"

type ReadUIMessageStream = typeof import("ai").readUIMessageStream
type ChatDevtoolsAction = "clear" | "get-state" | "send"
type ChatDevtoolsBridgeBody = {
  action?: string
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
  stream?: boolean
  text?: string
}

interface ChatDevtoolsInvokerSelection {
  invokerFallback?: boolean
  invokerProfileId?: string
}

interface ViteAgentDevtoolsRuntimeConfig extends AgentRuntimeConfig {
  agent?: unknown
}

interface ViteAgentDevtoolsRuntimeContext extends AgentRuntimeContext<ViteAgentDevtoolsRuntimeConfig> {
  request?: Request
  runtime: "vite"
  runtimeConfig: ViteAgentDevtoolsRuntimeConfig
}

interface ChatDevtoolsSession {
  invokerFallback?: boolean
  invokerProfileId?: string
  name: string
  thinkingFallback?: string | null
  title?: string
  uiMessages: UIMessage[]
}

interface ChatDevtoolsAgentEntry {
  agent: AgentInput<ViteAgentDevtoolsRuntimeContext>
  defaults?: WorkspaceAgentDefaults
  metadata: ChatDevtoolsMetadata
  metadataError?: string
  metadataSelectionKey?: string
  metadataStaticKey: string
  metadataStatus: ChatDevtoolsMetadataStatus
  metadataTask?: Promise<void>
  name: string
}

interface ChatDevtoolsBridgeState {
  entries: Map<string, ChatDevtoolsAgentEntry>
  sessions: Map<string, ChatDevtoolsSession>
  selected?: string
}

function normalizeChatDevtoolsAction(action: string): ChatDevtoolsAction | undefined {
  if (action === "get-state" || action === chatDevtoolsGetStateRpc) return "get-state"
  if (action === "send" || action === chatDevtoolsSendRpc) return "send"
  if (action === "clear" || action === chatDevtoolsClearRpc) return "clear"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function resolveAgentModule(module: unknown): AgentInput<ViteAgentDevtoolsRuntimeContext> | undefined {
  if (isRecord(module) && "default" in module) {
    return module.default as AgentInput<ViteAgentDevtoolsRuntimeContext> | undefined
  }
  return module as AgentInput<ViteAgentDevtoolsRuntimeContext> | undefined
}

function workspaceDefaults(definition: DiscoveredAgentDefinition): WorkspaceAgentDefaults | undefined {
  return definition.workspace
    ? { name: definition.name, workspace: definition.workspace }
    : undefined
}

function resolveWorkspaceSourceRoot(file: string): string {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : dirname(file)
}

function installServerAgentWorkspaceRegistry(server: ViteDevServer, definitions: DiscoveredAgentDefinition[]): void {
  setWorkspaceRuntimeRegistry(Object.fromEntries(definitions
    .filter(definition => definition.workspace)
    .map(definition => [
      definition.workspace!,
      async () => {
        const mod = await server.ssrLoadModule(pathToFileURL(definition.handler).href)
        const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
        return {
          ...mod,
          default: {
            ...mod.default,
            sourceRootDir: mod.default?.sourceRootDir ?? sourceRootDir,
          },
        }
      },
    ])))
}

async function loadDiscoveredAgent(
  server: ViteDevServer,
  definition: DiscoveredAgentDefinition,
): Promise<AgentInput<ViteAgentDevtoolsRuntimeContext> | undefined> {
  const module = await server.ssrLoadModule(pathToFileURL(definition.handler).href)
  const agent = resolveAgentModule(module)
  const defaults = workspaceDefaults(definition)
  return agent && defaults
    ? withWorkspaceAgentDefaults(agent as never, defaults as never) as AgentInput<ViteAgentDevtoolsRuntimeContext>
    : agent
}

function createDevtoolsDiscoveryContext(): ViteAgentDevtoolsRuntimeContext {
  return createAgentRuntimeContext({
    runtime: "vite",
    runtimeConfig: {},
    waitUntil: task => void Promise.resolve(task).catch(() => {}),
  }) as ViteAgentDevtoolsRuntimeContext
}

function headersFromNode(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result.set(name, value)
    else if (Array.isArray(value)) {
      for (const item of value) result.append(name, item)
    }
  }
  return result
}

function createRequest(server: ViteDevServer, req: IncomingMessage): Request {
  const base = server.resolvedUrls?.local?.[0] || `http://localhost:${server.config.server.port || 5173}/`
  return new Request(new URL(req.url || chatDevtoolsBridgeRoute, base), {
    headers: headersFromNode(req.headers),
    method: req.method || "GET",
  })
}

function createRuntimeContext(server: ViteDevServer, req: IncomingMessage, run: AgentRunMetadata): ViteAgentDevtoolsRuntimeContext {
  return createAgentRuntimeContext({
    request: createRequest(server, req),
    run,
    runtime: "vite",
    runtimeConfig: {},
    waitUntil: task => void Promise.resolve(task).catch(() => {}),
  }) as ViteAgentDevtoolsRuntimeContext
}

function createDevtoolsMetadataInput(selection: ChatDevtoolsInvokerSelection = {}): AgentRunInput {
  return {
    context: {
      ...(!selection.invokerFallback && selection.invokerProfileId ? { invokerProfileId: selection.invokerProfileId } : {}),
      chat: {
        message: { metadata: {} },
        run: { origin: "devtools" },
      },
    },
    messages: [],
  }
}

function agentHasInvokerProfile(agent: AgentInput<ViteAgentDevtoolsRuntimeContext>, invokerProfileId: string | undefined): boolean {
  return Boolean(invokerProfileId && Array.isArray(agent.invoker?.profiles) && agent.invoker.profiles.some(profile => profile.id === invokerProfileId))
}

function metadataSelectionForAgent(
  agent: AgentInput<ViteAgentDevtoolsRuntimeContext>,
  selection: ChatDevtoolsInvokerSelection = {},
): ChatDevtoolsInvokerSelection {
  if (selection.invokerFallback) return { invokerFallback: true }
  return agentHasInvokerProfile(agent, selection.invokerProfileId)
    ? { invokerProfileId: selection.invokerProfileId }
    : {}
}

function metadataSelectionKey(selection: ChatDevtoolsInvokerSelection = {}): string {
  if (selection.invokerFallback) return "fallback"
  return selection.invokerProfileId ? `profile:${selection.invokerProfileId}` : "default"
}

function canResolveWorkspaceMetadata(agent: AgentInput<ViteAgentDevtoolsRuntimeContext>): boolean {
  return Boolean((agent as { __vitehubWorkspaceAgent?: unknown }).__vitehubWorkspaceAgent)
}

function createStaticDevtoolsMetadata(agent: AgentInput<ViteAgentDevtoolsRuntimeContext>): ChatDevtoolsMetadata {
  return createAgentDevtoolsMetadata(agent as never)
}

function metadataStaticKey(metadata: ChatDevtoolsMetadata): string {
  return JSON.stringify(metadata)
}

function createChatDevtoolsAgentEntry(
  name: string,
  agent: AgentInput<ViteAgentDevtoolsRuntimeContext>,
  defaults: WorkspaceAgentDefaults | undefined,
  previous: ChatDevtoolsAgentEntry | undefined,
): ChatDevtoolsAgentEntry {
  const metadata = createStaticDevtoolsMetadata(agent)
  const staticKey = metadataStaticKey(metadata)
  if (previous?.metadataStaticKey === staticKey) {
    previous.agent = agent
    previous.defaults = defaults
    previous.name = name
    return previous
  }
  return {
    agent,
    defaults,
    metadata,
    metadataStaticKey: staticKey,
    metadataStatus: canResolveWorkspaceMetadata(agent) ? "loading" : "ready",
    name,
  }
}

function metadataErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Chat DevTools metadata inspection failed."
}

async function startMetadataResolution(
  entry: ChatDevtoolsAgentEntry,
  selection: ChatDevtoolsInvokerSelection = {},
  options: { force?: boolean } = {},
): Promise<void> {
  if (!canResolveWorkspaceMetadata(entry.agent)) {
    entry.metadataError = undefined
    entry.metadataSelectionKey = "static"
    entry.metadataStatus = "ready"
    entry.metadataTask = undefined
    return
  }

  const metadataSelection = metadataSelectionForAgent(entry.agent, selection)
  const selectionKey = metadataSelectionKey(metadataSelection)
  if (!options.force && entry.metadataSelectionKey === selectionKey) {
    return
  }

  entry.metadata = createStaticDevtoolsMetadata(entry.agent)
  entry.metadataStaticKey = metadataStaticKey(entry.metadata)
  entry.metadataError = undefined
  entry.metadataSelectionKey = selectionKey
  entry.metadataStatus = "loading"

  const task = resolveAgentDevtoolsMetadata(entry.agent as never, {
    ...entry.defaults,
    input: createDevtoolsMetadataInput(metadataSelection),
  } as never)
    .then((metadata) => {
      if (entry.metadataTask !== task || entry.metadataSelectionKey !== selectionKey) return
      entry.metadata = metadata
      entry.metadataError = undefined
      entry.metadataStatus = "ready"
      entry.metadataTask = undefined
    })
    .catch((cause) => {
      if (entry.metadataTask !== task || entry.metadataSelectionKey !== selectionKey) return
      entry.metadataError = metadataErrorMessage(cause)
      entry.metadataStatus = "error"
      entry.metadataTask = undefined
    })
  entry.metadataTask = task
  if (options.force) await task
}

async function discoverChatAgents(server: ViteDevServer, state: ChatDevtoolsBridgeState): Promise<void> {
  const context = createDevtoolsDiscoveryContext()
  const entries = new Map<string, ChatDevtoolsAgentEntry>()
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(server.config.root, "server")],
  }).sort((left, right) => left.name.localeCompare(right.name))
  installServerAgentWorkspaceRegistry(server, definitions)

  for (const definition of definitions) {
    const agent = await loadDiscoveredAgent(server, definition)
    if (!agent) continue
    const triggers = await resolveAgentTriggers(agent as never, context as never)
    const trigger = triggers["chat.message"]
    if (!trigger || trigger.devtools === false) continue

    entries.set(definition.name, createChatDevtoolsAgentEntry(
      definition.name,
      agent,
      workspaceDefaults(definition),
      state.entries.get(definition.name),
    ))
  }
  state.entries = entries
}

function getSession(state: ChatDevtoolsBridgeState, name: string): ChatDevtoolsSession {
  let session = state.sessions.get(name)
  if (!session) {
    session = { name, uiMessages: [] }
    state.sessions.set(name, session)
  }
  return session
}

function titleFromUIMessage(message: UIMessage): string | undefined {
  for (const part of message.parts || []) {
    const data = (part as { data?: unknown }).data
    if (
      (part as { type?: unknown }).type === "data-chat-title"
      && data
      && typeof data === "object"
      && (data as { type?: unknown }).type === "chat-title"
      && typeof (data as { title?: unknown }).title === "string"
    ) {
      const title = (data as { title: string }).title.trim()
      if (title) return title
    }
  }
}

function titleFromUIMessages(messages: UIMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const title = titleFromUIMessage(message)
    if (title) return title
  }
}

function sessionTitle(session: ChatDevtoolsSession): string | undefined {
  const title = session.title || titleFromUIMessages(session.uiMessages)
  if (title) session.title = title
  return title
}

function getSelectedName(state: ChatDevtoolsBridgeState, selected?: string): string {
  const names = [...state.entries.keys()]
  const next = selected && state.entries.has(selected)
    ? selected
    : state.selected && state.entries.has(state.selected)
      ? state.selected
      : names[0] || ""
  state.selected = next || undefined
  return next
}

function validMetadataInvokerProfileId(metadata: ChatDevtoolsMetadata | undefined, value: string | undefined): string | undefined {
  return value && metadata?.invokerProfiles?.some(profile => profile.id === value)
    ? value
    : undefined
}

function assertKnownInvokerProfile(metadata: ChatDevtoolsMetadata | undefined, invokerProfileId: string | undefined): void {
  if (invokerProfileId && !validMetadataInvokerProfileId(metadata, invokerProfileId)) {
    throw new Response(`Unknown invoker profile: ${invokerProfileId}`, { status: 400 })
  }
}

function normalizeInvokerSelection(input: { invokerFallback?: boolean, invokerProfileId?: string } | undefined): ChatDevtoolsInvokerSelection {
  if (input?.invokerFallback === true) return { invokerFallback: true }
  const invokerProfileId = input?.invokerProfileId?.trim()
  return invokerProfileId ? { invokerProfileId } : {}
}

async function serializeState(
  state: ChatDevtoolsBridgeState,
  selected?: string,
  requestedSelection: ChatDevtoolsInvokerSelection = {},
): Promise<ChatDevtoolsStateResult> {
  for (const name of state.entries.keys()) getSession(state, name)

  const chats: ChatDevtoolsConversation[] = [...state.entries.keys()].map((name) => {
    const session = getSession(state, name)
    const title = sessionTitle(session)
    return {
      messages: [],
      ...(session.invokerFallback ? { invokerFallback: true } : {}),
      ...(session.invokerProfileId ? { invokerProfileId: session.invokerProfileId } : {}),
      name,
      ...(title ? { title } : {}),
      uiMessages: [...session.uiMessages],
    }
  })

  const nextSelected = getSelectedName(state, selected)
  const selectedSession = nextSelected ? getSession(state, nextSelected) : undefined
  const entry = nextSelected ? state.entries.get(nextSelected) : undefined
  const metadata = entry?.metadata
  const title = selectedSession ? sessionTitle(selectedSession) || metadata?.title : metadata?.title
  const invokerProfileId = selectedSession?.invokerProfileId || (!requestedSelection.invokerFallback ? validMetadataInvokerProfileId(metadata, requestedSelection.invokerProfileId) : undefined)
  const invokerFallback = selectedSession?.invokerFallback || (!invokerProfileId && requestedSelection.invokerFallback === true)

  return {
    chats,
    files: metadata?.files || [],
    instructions: metadata?.instructions || [],
    ...(invokerFallback ? { invokerFallback: true } : {}),
    ...(invokerProfileId ? { invokerProfileId } : {}),
    invokerProfiles: metadata?.invokerProfiles || [],
    ...(entry?.metadataError ? { metadataError: entry.metadataError } : {}),
    ...(entry?.metadataStatus ? { metadataStatus: entry.metadataStatus } : {}),
    selected: nextSelected,
    thinkingFallback: selectedSession?.thinkingFallback ?? null,
    ...(title ? { title } : {}),
    tools: metadata?.tools || [],
    uiMessages: selectedSession ? [...selectedSession.uiMessages] : [],
    ...(metadata?.version ? { version: metadata.version } : {}),
  }
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createRunMetadata(session: ChatDevtoolsSession, userMessageId: string): AgentRunMetadata {
  return {
    channelId: `devtools:${session.name}`,
    messageId: userMessageId,
    origin: "devtools",
    runId: globalThis.crypto?.randomUUID?.() || randomId("devtools-run"),
    threadId: `devtools:${session.name}:thread`,
  }
}

function createUserUIMessage(text: string): UIMessage {
  return {
    id: randomId("devtools-user"),
    metadata: {},
    parts: [{ text, type: "text" }],
    role: "user",
  }
}

function uiMessageMetadata(message: UIMessage): Record<string, unknown> | undefined {
  return isRecord(message.metadata) ? message.metadata : undefined
}

function hasCompletedMetadata(message: UIMessage): boolean {
  const completedAt = uiMessageMetadata(message)?.completedAt
  return typeof completedAt === "string" && completedAt.trim().length > 0
}

function isToolUIMessagePart(part: unknown): part is Record<string, unknown> {
  if (!isRecord(part)) return false
  return part.type === "dynamic-tool"
    || (typeof part.type === "string" && part.type.startsWith("tool-"))
}

function toolPartHasOutput(part: Record<string, unknown>): boolean {
  return part.state === "output-available"
    || part.state === "output-denied"
    || Object.prototype.hasOwnProperty.call(part, "output")
    || typeof part.errorText === "string"
}

function hasIncompleteToolParts(message: UIMessage): boolean {
  return (message.parts || []).some(part => isToolUIMessagePart(part) && !toolPartHasOutput(part))
}

function isIncompleteAssistantHistoryMessage(message: UIMessage): boolean {
  return message.role === "assistant" && !hasCompletedMetadata(message) && hasIncompleteToolParts(message)
}

export function createChatDevtoolsPromptHistory(messages: UIMessage[]): UIMessage[] {
  return messages.filter(message => !isIncompleteAssistantHistoryMessage(message))
}

function readableStreamFromResult(value: unknown): ReadableStream<never> {
  if (value instanceof ReadableStream) return value as ReadableStream<never>
  if (value instanceof Response && value.body) return value.body as ReadableStream<never>
  throw new Error("[vitehub] Chat DevTools expected a UI message stream.")
}

async function sendDevtoolsUIMessage(
  server: ViteDevServer,
  req: IncomingMessage,
  state: ChatDevtoolsBridgeState,
  input: { chat?: string, invokerFallback?: boolean, invokerProfileId?: string, stream?: boolean, text?: string },
  onChange?: (next: ChatDevtoolsStateResult) => void | Promise<void>,
): Promise<ChatDevtoolsStateResult> {
  if (!input.stream) {
    throw new Response("AI SDK Chat DevTools sends require stream: true.", { status: 400 })
  }

  const text = input.text?.trim()
  if (!text) {
    throw new Response("Missing chat message text.", { status: 400 })
  }

  const selected = getSelectedName(state, input.chat)
  if (!selected) {
    throw new Response("No chats are registered for DevTools.", { status: 404 })
  }

  const entry = state.entries.get(selected)
  if (!entry) {
    throw new Response(`Unknown chat: ${selected}`, { status: 404 })
  }

  const session = getSession(state, selected)
  state.selected = selected
  const requestedSelection = normalizeInvokerSelection(input)
  const requestedProfileId = requestedSelection.invokerProfileId
  assertKnownInvokerProfile(entry.metadata, requestedProfileId)
  if (
    session.uiMessages.length > 0
    && ((requestedSelection.invokerFallback && !session.invokerFallback)
      || (requestedProfileId && (session.invokerFallback || (session.invokerProfileId && requestedProfileId !== session.invokerProfileId))))
  ) {
    throw new Response("Clear the conversation to change invoker.", { status: 409 })
  }
  if (!session.uiMessages.length) {
    session.invokerFallback = requestedSelection.invokerFallback === true
    session.invokerProfileId = session.invokerFallback
      ? undefined
      : requestedProfileId || entry.metadata.invokerProfiles?.[0]?.id
  }
  const userMessage = createUserUIMessage(text)
  const baseMessages = [...createChatDevtoolsPromptHistory(session.uiMessages), userMessage]
  const run = createRunMetadata(session, userMessage.id)
  const startedAt = new Date().toISOString()
  session.uiMessages = baseMessages
  session.thinkingFallback = null
  await onChange?.(await serializeState(state, selected))

  const runtimeContext = createRuntimeContext(server, req, run)
  const triggerInput: AgentChatMessageTriggerInput = {
    ...(session.invokerProfileId ? { invokerProfileId: session.invokerProfileId } : {}),
    messages: baseMessages,
    run,
    timeout: 90_000,
  }
  const stream = readableStreamFromResult(await streamAgentTrigger(entry.agent as never, runtimeContext as never, "chat.message", triggerInput, {
    output: "ui-message-stream",
    async onInvocation(invocation) {
      session.thinkingFallback = typeof invocation.metadata?.thinkingFallback === "string"
        ? invocation.metadata.thinkingFallback
        : null
      await onChange?.(await serializeState(state, selected))
    },
  }))
  const { readUIMessageStream } = await import("ai") as { readUIMessageStream: ReadUIMessageStream }
  let latestAssistant: UIMessage | undefined
  for await (const assistantMessage of readUIMessageStream({ stream })) {
    const now = new Date().toISOString()
    latestAssistant = {
      ...assistantMessage as UIMessage,
      metadata: {
        ...((assistantMessage as UIMessage).metadata as Record<string, unknown> | undefined),
        createdAt: startedAt,
        updatedAt: now,
      },
    }
    session.title = titleFromUIMessage(latestAssistant) || session.title
    session.uiMessages = [...baseMessages, latestAssistant]
    await onChange?.(await serializeState(state, selected))
  }
  if (latestAssistant) {
    latestAssistant = {
      ...latestAssistant,
      metadata: {
        ...(latestAssistant.metadata as Record<string, unknown> | undefined),
        completedAt: new Date().toISOString(),
      },
    }
    session.title = titleFromUIMessage(latestAssistant) || session.title
    session.uiMessages = [...baseMessages, latestAssistant]
    await onChange?.(await serializeState(state, selected))
  }
  await startMetadataResolution(entry, requestedSelection, { force: true })
  return await serializeState(state, selected)
}

async function clearDevtoolsMessages(state: ChatDevtoolsBridgeState, input: { chat?: string, invokerFallback?: boolean, invokerProfileId?: string }): Promise<ChatDevtoolsStateResult> {
  const selected = getSelectedName(state, input.chat)
  if (!selected) return await serializeState(state)
  const entry = state.entries.get(selected)
  if (!entry) return await serializeState(state)
  const session = getSession(state, selected)
  const requestedSelection = normalizeInvokerSelection(input)
  assertKnownInvokerProfile(entry.metadata, requestedSelection.invokerProfileId)
  state.selected = selected
  session.thinkingFallback = null
  session.invokerFallback = requestedSelection.invokerFallback === true
  session.invokerProfileId = session.invokerFallback ? undefined : requestedSelection.invokerProfileId
  session.title = undefined
  session.uiMessages = []
  return await serializeState(state, selected, requestedSelection)
}

function createChatDevtoolsStreamResponse(run: (emit: (event: ChatDevtoolsStreamEvent) => void, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const abortController = new AbortController()
  let closed = false

  function emit(controller: ReadableStreamDefaultController<Uint8Array>, event: ChatDevtoolsStreamEvent): void {
    if (closed || abortController.signal.aborted) return
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
    }
    catch {
      closed = true
      abortController.abort()
    }
  }

  return new Response(new ReadableStream({
    start(controller) {
      run(event => emit(controller, event), abortController.signal)
        .then(() => {
          if (closed || abortController.signal.aborted) return
          emit(controller, { type: "done" })
          if (!closed) {
            closed = true
            controller.close()
          }
        })
        .catch((cause) => {
          if (closed || abortController.signal.aborted) return
          emit(controller, {
            message: cause instanceof Error ? cause.message : "Chat DevTools stream failed.",
            type: "error",
          })
          if (!closed) {
            closed = true
            controller.close()
          }
        })
    },
    cancel() {
      closed = true
      abortController.abort()
    },
  }), {
    headers: { "content-type": "application/x-ndjson" },
  })
}

function parseChatDevtoolsBridgeBody(rawBody: string): ChatDevtoolsBridgeBody | undefined {
  if (!rawBody.trim()) return undefined
  try {
    return JSON.parse(rawBody) as ChatDevtoolsBridgeBody
  }
  catch {
    throw new Response("Malformed chat devtools payload.", { status: 400 })
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = ""
  req.setEncoding("utf8")
  for await (const chunk of req) body += chunk
  return body
}

async function handleChatDevtoolsRequest(
  server: ViteDevServer,
  req: IncomingMessage,
  state: ChatDevtoolsBridgeState,
): Promise<Response> {
  const body = parseChatDevtoolsBridgeBody(await readRequestBody(req))
  if (!body || typeof body.action !== "string") {
    return new Response("Missing chat devtools action.", { status: 400 })
  }

  const invokerSelection = normalizeInvokerSelection(body)
  await discoverChatAgents(server, state)
  if (body.chat && state.entries.has(body.chat)) {
    state.selected = body.chat
  }
  const selected = getSelectedName(state, body.chat)
  const entry = selected ? state.entries.get(selected) : undefined
  if (entry) {
    await startMetadataResolution(entry, invokerSelection)
  }

  const action = normalizeChatDevtoolsAction(body.action)
  if (action === "get-state") {
    return Response.json(await serializeState(state, body.chat, invokerSelection))
  }
  if (action === "send") {
    if (!body.stream) {
      return new Response("Chat DevTools sends require stream: true.", { status: 400 })
    }
    return createChatDevtoolsStreamResponse(async (emit, signal) => {
      const finalState = await sendDevtoolsUIMessage(server, req, state, body, (next) => {
        if (!signal.aborted) emit({ state: next, type: "state" })
      })
      if (!signal.aborted) emit({ state: finalState, type: "state" })
    })
  }
  if (action === "clear") {
    return Response.json(await clearDevtoolsMessages(state, body))
  }

  return new Response(`Unknown chat devtools action: ${body.action}`, { status: 400 })
}

function routeMatches(req: IncomingMessage): boolean {
  return new URL(req.url || "/", "http://localhost").pathname === chatDevtoolsBridgeRoute
}

function installChatDevtoolsInvalidation(server: ViteDevServer, state: ChatDevtoolsBridgeState): void {
  const serverRoot = join(server.config.root, "server")
  const invalidate = (file: string) => {
    if (file.startsWith(serverRoot)) {
      state.entries = new Map()
    }
  }
  server.watcher?.on("add", invalidate)
  server.watcher?.on("change", invalidate)
  server.watcher?.on("unlink", invalidate)
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) {
    res.setHeader(name, value)
  }
  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    res.end()
  }
  catch (error) {
    res.destroy(error instanceof Error ? error : undefined)
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof Response) return error
  return new Response(error instanceof Error ? error.message : "Chat DevTools bridge failed.", {
    status: 500,
  })
}

export function registerChatDevtoolsBridge(server: ViteDevServer): void {
  const state: ChatDevtoolsBridgeState = {
    entries: new Map(),
    sessions: new Map(),
  }
  installChatDevtoolsInvalidation(server, state)

  server.middlewares.use((req, res, next) => {
    if (!routeMatches(req)) {
      next()
      return
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204
      res.setHeader("access-control-allow-origin", "*")
      res.setHeader("access-control-allow-methods", "POST, OPTIONS")
      res.setHeader("access-control-allow-headers", "content-type")
      res.end()
      return
    }
    if (req.method !== "POST") {
      void writeResponse(res, new Response("Method not allowed.", { status: 405 }))
      return
    }

    void handleChatDevtoolsRequest(server, req, state)
      .then((response) => {
        response.headers.set("access-control-allow-origin", "*")
        return writeResponse(res, response)
      })
      .catch((error) => {
        const response = errorResponse(error)
        response.headers.set("access-control-allow-origin", "*")
        return writeResponse(res, response)
      })
  })
}
