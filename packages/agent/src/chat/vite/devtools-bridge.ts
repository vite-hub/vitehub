import { join } from "node:path"

import { setWorkspaceRuntimeRegistry } from "@vite-hub/workspace/runtime"

import {
  createAgentDevtoolsMetadata,
  materializeAgentDevtoolsSourceMetadata,
  resolveAgentDevtoolsMetadata,
  resolveAgentTriggers,
  streamAgentTrigger,
} from "../../index.ts"
import {
  type ChatDevtoolsConversation,
  type ChatDevtoolsMetadata,
  type ChatDevtoolsMetadataStatus,
  type ChatDevtoolsStateResult,
  chatDevtoolsBridgeRoute,
} from "../devtools.ts"
import {
  chatDevtoolsMetadataErrorMessage,
  chatDevtoolsMetadataSelection,
  chatDevtoolsMetadataSelectionKey,
  chatDevtoolsMetadataWithAgentName,
  chatDevtoolsSessionTitle,
  consumeChatDevtoolsUIMessageStream,
  createChatDevtoolsMetadataInput,
  createChatDevtoolsPromptHistory,
  createChatDevtoolsUserUIMessage,
  materializedChatDevtoolsSourceKeys,
  normalizeChatDevtoolsAction,
  normalizeChatDevtoolsInvokerSelection,
  refreshChatDevtoolsMetadata,
  validChatDevtoolsInvokerProfileId,
} from "../devtools-runtime.ts"
import { createChatDevtoolsStreamResponse } from "../devtools-stream.ts"
import { discoverAgentDefinitions } from "../../discovery.ts"
import { workspaceAgentOwnsWorkspaceDefinition } from "../../workspace-agent.ts"
import {
  createViteAgentDiscoveryContext,
  createViteAgentRuntimeContext,
  createViteWorkspaceAgentLoader,
  loadViteAgent,
  writeViteResponse,
} from "../../vite/runtime-adapter.ts"

import type { IncomingMessage } from "node:http"
import type { ViteDevServer } from "vite"
import type { ChatDevtoolsBridgeBody, ChatDevtoolsInvokerSelection, ChatDevtoolsSession as ChatDevtoolsSessionState } from "../devtools-runtime.ts"
import type { AgentChatMessageTriggerInput } from "../../chat-trigger.ts"
import type { ViteAgentRuntimeContext } from "../../vite/runtime-adapter.ts"
import type {
  AgentInput,
  AgentHostIdentity,
  AgentRunMetadata,
  DiscoveredAgentDefinition,
} from "../../index.ts"

const chatDevtoolsUser: Record<string, unknown> = {
  id: "devtools",
  name: "DevTools User",
}

interface ChatDevtoolsSession extends ChatDevtoolsSessionState {
  name: string
}

interface ChatDevtoolsAgentEntry {
  agent: AgentInput<ViteAgentRuntimeContext>
  identity: AgentHostIdentity
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
  root: string
  sessions: Map<string, ChatDevtoolsSession>
  selected?: string
}

function installServerAgentWorkspaceRegistry(
  server: ViteDevServer,
  entries: Array<{ agent: AgentInput<ViteAgentRuntimeContext>, definition: DiscoveredAgentDefinition }>,
): void {
  setWorkspaceRuntimeRegistry(Object.fromEntries(entries
    .filter(entry => entry.definition.workspace && workspaceAgentOwnsWorkspaceDefinition(entry.agent))
    .map(({ definition }) => [
      definition.workspace!,
      createViteWorkspaceAgentLoader(server, definition),
    ])))
}

function createDevtoolsMetadataRunMetadata(name: string): AgentRunMetadata<"devtools"> {
  return {
    channelId: `devtools:${name}`,
    origin: "devtools",
    runId: `devtools:${name}:metadata`,
    threadId: `devtools:${name}:thread`,
  }
}

function metadataSelectionForAgent(
  agent: AgentInput<ViteAgentRuntimeContext>,
  selection: ChatDevtoolsInvokerSelection = {},
): ChatDevtoolsInvokerSelection {
  return chatDevtoolsMetadataSelection(createAgentDevtoolsMetadata(agent as never), selection)
}

function canResolveWorkspaceMetadata(agent: AgentInput<ViteAgentRuntimeContext>): boolean {
  return Boolean((agent as { __vitehubWorkspaceAgent?: unknown }).__vitehubWorkspaceAgent)
}

function createStaticDevtoolsMetadata(name: string, agent: AgentInput<ViteAgentRuntimeContext>): ChatDevtoolsMetadata {
  return chatDevtoolsMetadataWithAgentName(createAgentDevtoolsMetadata(agent as never), name)
}

function metadataStaticKey(metadata: ChatDevtoolsMetadata): string {
  return JSON.stringify(metadata)
}

function createChatDevtoolsAgentEntry(
  name: string,
  agent: AgentInput<ViteAgentRuntimeContext>,
  identity: AgentHostIdentity,
  previous: ChatDevtoolsAgentEntry | undefined,
): ChatDevtoolsAgentEntry {
  const metadata = createStaticDevtoolsMetadata(name, agent)
  const staticKey = metadataStaticKey(metadata)
  if (previous?.metadataStaticKey === staticKey) {
    previous.agent = agent
    previous.identity = identity
    previous.name = name
    return previous
  }
  return {
    agent,
    identity,
    metadata,
    metadataStaticKey: staticKey,
    metadataStatus: canResolveWorkspaceMetadata(agent) ? "loading" : "ready",
    name,
  }
}

async function startMetadataResolution(
  entry: ChatDevtoolsAgentEntry,
  selection: ChatDevtoolsInvokerSelection = {},
  options: { force?: boolean } = {},
): Promise<void> {
  await refreshChatDevtoolsMetadata({
    canResolve: canResolveWorkspaceMetadata(entry.agent),
    force: options.force,
    name: entry.name,
    onStaticMetadata(metadata) {
      entry.metadataStaticKey = metadataStaticKey(metadata)
    },
    async resolve(metadataSelection) {
      const run = createDevtoolsMetadataRunMetadata(entry.name)
      return await resolveAgentDevtoolsMetadata(entry.agent as never, {
        input: createChatDevtoolsMetadataInput(metadataSelection, run, chatDevtoolsUser),
        runtime: { agentIdentity: entry.identity, run },
      } as never)
    },
    selection,
    state: entry,
    staticMetadata: createStaticDevtoolsMetadata(entry.name, entry.agent),
  })
}

async function discoverChatAgents(server: ViteDevServer, state: ChatDevtoolsBridgeState): Promise<void> {
  const entries = new Map<string, ChatDevtoolsAgentEntry>()
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(server.config.root, "server")],
  }).sort((left, right) => left.name.localeCompare(right.name))

  const loaded = []
  for (const definition of definitions) {
    const entry = await loadViteAgent(server, definition)
    if (entry) loaded.push(entry)
  }
  installServerAgentWorkspaceRegistry(server, loaded)

  for (const { agent, definition, identity } of loaded) {
    const context = createViteAgentDiscoveryContext(identity)
    const triggers = await resolveAgentTriggers(agent as never, context as never)
    const trigger = triggers["chat.message"]
    if (!trigger || trigger.devtools === false) continue

    entries.set(definition.name, createChatDevtoolsAgentEntry(
      definition.name,
      agent,
      identity,
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

function assertKnownInvokerProfile(metadata: ChatDevtoolsMetadata | undefined, invokerProfileId: string | undefined): void {
  if (invokerProfileId && !validChatDevtoolsInvokerProfileId(metadata, invokerProfileId)) {
    throw new Response(`Unknown invoker profile: ${invokerProfileId}`, { status: 400 })
  }
}

async function serializeState(
  state: ChatDevtoolsBridgeState,
  selected?: string,
  requestedSelection: ChatDevtoolsInvokerSelection = {},
): Promise<ChatDevtoolsStateResult> {
  for (const name of state.entries.keys()) getSession(state, name)

  const chats: ChatDevtoolsConversation[] = [...state.entries.keys()].map((name) => {
    const session = getSession(state, name)
    const title = chatDevtoolsSessionTitle(session)
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
  const title = selectedSession ? chatDevtoolsSessionTitle(selectedSession) || metadata?.name : metadata?.name
  const invokerProfileId = selectedSession?.invokerProfileId || (!requestedSelection.invokerFallback ? validChatDevtoolsInvokerProfileId(metadata, requestedSelection.invokerProfileId) : undefined)
  const invokerFallback = selectedSession?.invokerFallback || (!invokerProfileId && requestedSelection.invokerFallback === true)

  return {
    chats,
    ...(metadata?.config ? { config: metadata.config } : {}),
    files: metadata?.files || [],
    instructions: metadata?.instructions || [],
    ...(invokerFallback ? { invokerFallback: true } : {}),
    ...(invokerProfileId ? { invokerProfileId } : {}),
    invokerProfiles: metadata?.invokerProfiles || [],
    ...(requestedSelection.meta ? { meta: requestedSelection.meta } : {}),
    ...(entry?.metadataError ? { metadataError: entry.metadataError } : {}),
    ...(entry?.metadataStatus ? { metadataStatus: entry.metadataStatus } : {}),
    root: state.root,
    selected: nextSelected,
    thinkingFallback: selectedSession?.thinkingFallback ?? null,
    ...(title ? { title } : {}),
    tools: metadata?.tools || [],
    uiMessages: selectedSession ? [...selectedSession.uiMessages] : [],
    ...(metadata?.version ? { version: metadata.version } : {}),
    warnings: metadata?.warnings || [],
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

export { createChatDevtoolsPromptHistory } from "../devtools-runtime.ts"

function readableStreamFromResult(value: unknown): ReadableStream<never> {
  if (value instanceof ReadableStream) return value as ReadableStream<never>
  if (value instanceof Response && value.body) return value.body as ReadableStream<never>
  throw new Error("[vitehub] Chat DevTools expected a UI message stream.")
}

async function sendDevtoolsUIMessage(
  server: ViteDevServer,
  req: IncomingMessage,
  state: ChatDevtoolsBridgeState,
  input: ChatDevtoolsBridgeBody,
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
  const selectedEntry: ChatDevtoolsAgentEntry = entry

  const session = getSession(state, selected)
  state.selected = selected
  const requestedSelection = normalizeChatDevtoolsInvokerSelection(input)
  const requestedProfileId = requestedSelection.invokerProfileId
  assertKnownInvokerProfile(selectedEntry.metadata, requestedProfileId)
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
      : requestedProfileId || selectedEntry.metadata.invokerProfiles?.[0]?.id
  }
  const userMessage = createChatDevtoolsUserUIMessage(text, randomId("devtools-user"))
  const baseMessages = [...createChatDevtoolsPromptHistory(session.uiMessages), userMessage]
  const run = createRunMetadata(session, userMessage.id)
  const startedAt = new Date().toISOString()
  session.uiMessages = baseMessages
  session.thinkingFallback = null
  await onChange?.(await serializeState(state, selected))

  const runtimeContext = createViteAgentRuntimeContext(server, req, selectedEntry.identity, { fallbackRoute: chatDevtoolsBridgeRoute, run })
  const triggerInput: AgentChatMessageTriggerInput = {
    ...(session.invokerProfileId ? { invokerProfileId: session.invokerProfileId } : {}),
    ...(requestedSelection.meta ? { meta: requestedSelection.meta } : {}),
    messages: baseMessages,
    run,
    timeout: 90_000,
    user: chatDevtoolsUser,
  }
  const stream = readableStreamFromResult(await streamAgentTrigger(selectedEntry.agent as never, runtimeContext as never, "chat.message", triggerInput, {
    output: "ui-message-stream",
    async onInvocation(invocation) {
      session.thinkingFallback = typeof invocation.metadata?.thinkingFallback === "string"
        ? invocation.metadata.thinkingFallback
        : null
      await onChange?.(await serializeState(state, selected))
    },
  }))
  await consumeChatDevtoolsUIMessageStream({
    baseMessages,
    async onChange() {
      await onChange?.(await serializeState(state, selected))
    },
    async onCompletedMaterializations() {
      await startMetadataResolution(selectedEntry, requestedSelection, { force: true })
    },
    session,
    startedAt,
    stream,
  })
  await startMetadataResolution(selectedEntry, requestedSelection, { force: true })
  return await serializeState(state, selected)
}

async function clearDevtoolsMessages(state: ChatDevtoolsBridgeState, input: ChatDevtoolsBridgeBody): Promise<ChatDevtoolsStateResult> {
  const selected = getSelectedName(state, input.chat)
  if (!selected) return await serializeState(state)
  const entry = state.entries.get(selected)
  if (!entry) return await serializeState(state)
  const session = getSession(state, selected)
  const requestedSelection = normalizeChatDevtoolsInvokerSelection(input)
  assertKnownInvokerProfile(entry.metadata, requestedSelection.invokerProfileId)
  state.selected = selected
  session.thinkingFallback = null
  session.invokerFallback = requestedSelection.invokerFallback === true
  session.invokerProfileId = session.invokerFallback ? undefined : requestedSelection.invokerProfileId
  session.title = undefined
  session.uiMessages = []
  return await serializeState(state, selected, requestedSelection)
}

async function materializeDevtoolsSource(
  state: ChatDevtoolsBridgeState,
  input: ChatDevtoolsBridgeBody,
): Promise<ChatDevtoolsStateResult> {
  const selected = getSelectedName(state, input.chat)
  if (!selected) return await serializeState(state)
  const entry = state.entries.get(selected)
  if (!entry) return await serializeState(state)
  if (!input.source && !input.path) {
    throw new Response("Missing workspace source or path.", { status: 400 })
  }

  const requestedSelection = normalizeChatDevtoolsInvokerSelection(input)
  assertKnownInvokerProfile(entry.metadata, requestedSelection.invokerProfileId)
  const metadataSelection = metadataSelectionForAgent(entry.agent, requestedSelection)
  state.selected = selected
  entry.metadataStatus = "loading"
  entry.metadataError = undefined

  try {
    const run = createDevtoolsMetadataRunMetadata(entry.name)
    const metadata = await materializeAgentDevtoolsSourceMetadata(entry.agent as never, {
      input: createChatDevtoolsMetadataInput(metadataSelection, run, chatDevtoolsUser),
      ...(input.path ? { path: input.path } : {}),
      ...(input.source ? { source: input.source } : {}),
      runtime: { agentIdentity: entry.identity, run },
      sources: materializedChatDevtoolsSourceKeys(entry.metadata),
    } as never)
    entry.metadata = chatDevtoolsMetadataWithAgentName(metadata, entry.name)
    entry.metadataSelectionKey = chatDevtoolsMetadataSelectionKey(metadataSelection)
    entry.metadataStatus = "ready"
    entry.metadataTask = undefined
  }
  catch {
    entry.metadataError = chatDevtoolsMetadataErrorMessage()
    entry.metadataStatus = "error"
  }

  return await serializeState(state, selected, requestedSelection)
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

  const invokerSelection = normalizeChatDevtoolsInvokerSelection(body)
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
  if (action === "materialize-source") {
    return Response.json(await materializeDevtoolsSource(state, body))
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

function errorResponse(error: unknown): Response {
  if (error instanceof Response) return error
  return new Response("Chat DevTools bridge failed.", {
    status: 500,
  })
}

export function registerChatDevtoolsBridge(server: ViteDevServer): void {
  const state: ChatDevtoolsBridgeState = {
    entries: new Map(),
    root: server.config.root,
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
      void writeViteResponse(res, new Response("Method not allowed.", { status: 405 }))
      return
    }

    void handleChatDevtoolsRequest(server, req, state)
      .then((response) => {
        response.headers.set("access-control-allow-origin", "*")
        return writeViteResponse(res, response)
      })
      .catch((error) => {
        const response = errorResponse(error)
        response.headers.set("access-control-allow-origin", "*")
        return writeViteResponse(res, response)
      })
  })
}
