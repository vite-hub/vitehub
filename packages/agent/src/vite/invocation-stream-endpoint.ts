import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { setWorkspaceRuntimeRegistry } from "@vite-hub/workspace/runtime"

import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute, createAgentInvocationStreamResponse } from "../invocation-stream.ts"
import { streamAgentOutputToEvents } from "../agent-output.ts"
import { uiMessagesToAgentMessages } from "../chat-message-input.ts"
import { discoverAgentDefinitions } from "../discovery.ts"
import { isResolvedAgentTriggerHandledInvocation, resolveAgentTriggerInvocation, resolveAgentTriggers, runAgentInline, streamAgent, withAgentDefaults } from "../index.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import { workspaceAgentOwnsWorkspaceDefinition, workspaceAgentWithSourceRoot } from "../workspace-agent.ts"

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import type { ViteDevServer } from "vite"
import type { AgentChatMessageTriggerInput } from "../chat-trigger.ts"
import type { AgentInvocationStreamEvent } from "../invocation-stream.ts"
import type {
  AgentChannelDeliveryEffectContext,
  AgentCapabilityCliExecutionInput,
  AgentCapabilityCliExecutionResult,
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  DiscoveredAgentDefinition,
  ResolvedAgentTriggerDefinition,
} from "../index.ts"

interface ViteAgentDevRuntimeConfig extends AgentRuntimeConfig {
  agent?: unknown
}

interface ViteAgentDevRuntimeContext extends AgentRuntimeContext<ViteAgentDevRuntimeConfig> {
  request?: Request
  runtime: "vite"
  runtimeConfig: ViteAgentDevRuntimeConfig
}

interface AgentInvocationStreamBody {
  agent?: string
  cli?: {
    argv?: string[]
    input?: unknown
    json?: boolean
    name?: string
  }
  invokerProfileId?: string
  messages?: AgentChatMessageTriggerInput["messages"]
  meta?: Record<string, unknown>
  payload?: unknown
  run?: AgentRunMetadata
  text?: string
  timeout?: number
  trigger?: string
}

interface AgentInvocationStreamEntry {
  agent: AgentInput<ViteAgentDevRuntimeContext>
  aliases?: string[]
  name: string
  triggers: Record<string, ResolvedAgentTriggerDefinition<ViteAgentDevRuntimeContext>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function payloadFromBody(body: AgentInvocationStreamBody): Record<string, unknown> | undefined {
  if (body.payload === undefined) return undefined
  if (!isRecord(body.payload)) {
    throw new Response("Agent Dev Loop payload must be a JSON object.", { status: 400 })
  }
  return body.payload
}

function withDevLoopControls<TInput extends object>(
  input: TInput,
  signal: AbortSignal,
  timeout: number,
): TInput & { abortSignal: AbortSignal, timeout: number } {
  return {
    ...input,
    abortSignal: signal,
    timeout,
  }
}

function withPayloadDefaults(payload: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const input = { ...payload }
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined && input[key] === undefined) input[key] = value
  }
  return input
}

function withDeliveryPreviewChannels(
  agent: AgentInput<ViteAgentDevRuntimeContext>,
  preview: (event: Extract<AgentInvocationStreamEvent, { type: "delivery-preview" }>) => void,
): AgentInput<ViteAgentDevRuntimeContext> {
  if (!isRecord(agent) || !isRecord(agent.channels)) return agent
  const channels = Object.fromEntries(Object.entries(agent.channels).map(([channelId, channel]) => {
    if (!isRecord(channel) || !isRecord(channel.effects)) return [channelId, channel]
    const effects = Object.fromEntries(Object.keys(channel.effects).map(kind => [kind, (context: AgentChannelDeliveryEffectContext<ViteAgentDevRuntimeConfig>) => {
      preview({
        channelId: context.trigger?.channelId || context.run?.channelId || channelId,
        effect: context.effect,
        ...(context.run ? { run: context.run } : {}),
        type: "delivery-preview",
      })
    }]))
    return [channelId, { ...channel, effects }]
  }))
  return { ...agent, channels } as AgentInput<ViteAgentDevRuntimeContext>
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
  return new Request(new URL(req.url || agentInvocationStreamRoute, base), {
    headers: headersFromNode(req.headers),
    method: req.method || "GET",
  })
}

function requestOrigin(server: ViteDevServer, req: IncomingMessage): string {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  if (host) {
    const fallback = server.resolvedUrls?.local?.[0] || "http://localhost/"
    return new URL(`${new URL(fallback).protocol}//${host}`).origin
  }
  const base = server.resolvedUrls?.local?.[0] || `http://localhost:${server.config.server.port || 5173}/`
  return new URL(base).origin
}

function validateDevLoopRequest(server: ViteDevServer, req: IncomingMessage): Response | undefined {
  const header = req.headers[agentInvocationStreamHeader]
  if ((Array.isArray(header) ? header[0] : header) !== agentInvocationStreamHeaderValue) {
    return new Response("Forbidden Agent Dev Loop request.", { status: 403 })
  }
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  if (origin && origin !== requestOrigin(server, req)) {
    return new Response("Forbidden Agent Dev Loop origin.", { status: 403 })
  }
  if (req.method !== "POST") return
  const contentType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"]
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return new Response("Agent Dev Loop requests must use application/json.", { status: 415 })
  }
}

function createRuntimeContext(server: ViteDevServer, req: IncomingMessage, run?: AgentRunMetadata): ViteAgentDevRuntimeContext {
  return createAgentRuntimeContext({
    request: createRequest(server, req),
    ...(run ? { run } : {}),
    runtime: "vite",
    runtimeConfig: {},
    waitUntil: task => void Promise.resolve(task).catch(() => {}),
  }) as ViteAgentDevRuntimeContext
}

function createDiscoveryContext(): ViteAgentDevRuntimeContext {
  return createAgentRuntimeContext({
    runtime: "vite",
    runtimeConfig: {},
    waitUntil: task => void Promise.resolve(task).catch(() => {}),
  }) as ViteAgentDevRuntimeContext
}

function resolveAgentModule(module: unknown): AgentInput<ViteAgentDevRuntimeContext> | undefined {
  if (isRecord(module) && "default" in module) {
    return module.default as AgentInput<ViteAgentDevRuntimeContext> | undefined
  }
  return module as AgentInput<ViteAgentDevRuntimeContext> | undefined
}

function resolveWorkspaceSourceRoot(file: string): string {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : dirname(file)
}

function declaredWorkspaceAgentName(agent: AgentInput<ViteAgentDevRuntimeContext> | undefined): string | undefined {
  const options = isRecord(agent) && isRecord(agent.__vitehubWorkspaceAgentOptions) ? agent.__vitehubWorkspaceAgentOptions : undefined
  return typeof options?.name === "string" && options.name ? options.name : undefined
}

function agentAliases(definition: DiscoveredAgentDefinition, agent: AgentInput<ViteAgentDevRuntimeContext>): string[] | undefined {
  const declaredName = declaredWorkspaceAgentName(agent)
  return declaredName && declaredName !== definition.name ? [declaredName] : undefined
}

function installServerAgentWorkspaceRegistry(
  server: ViteDevServer,
  entries: Array<{ agent: AgentInput<ViteAgentDevRuntimeContext>, aliases?: string[], definition: DiscoveredAgentDefinition }>,
): void {
  setWorkspaceRuntimeRegistry(Object.fromEntries(entries
    .filter(entry => entry.definition.workspace && workspaceAgentOwnsWorkspaceDefinition(entry.agent))
    .flatMap(({ aliases, definition }) => [definition.workspace!, ...(aliases || [])].map(name => [
      name,
      async () => {
        const mod = await server.ssrLoadModule(pathToFileURL(definition.handler).href)
        const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
        return {
          ...mod,
          default: workspaceAgentWithSourceRoot(mod.default, sourceRootDir),
        }
      },
    ]))))
}

async function loadDiscoveredAgent(
  server: ViteDevServer,
  definition: DiscoveredAgentDefinition,
): Promise<AgentInput<ViteAgentDevRuntimeContext> | undefined> {
  const module = await server.ssrLoadModule(pathToFileURL(definition.handler).href)
  const agent = resolveAgentModule(module)
  return withAgentDefaults(agent, { inferredName: definition.name, workspace: definition.workspace }) as AgentInput<ViteAgentDevRuntimeContext>
}

async function discoverStreamAgents(server: ViteDevServer): Promise<AgentInvocationStreamEntry[]> {
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(server.config.root, "server")],
  })
  const loaded = []
  for (const definition of definitions) {
    const agent = await loadDiscoveredAgent(server, definition)
    if (!agent) continue
    loaded.push({ agent, aliases: agentAliases(definition, agent), definition })
  }
  installServerAgentWorkspaceRegistry(server, loaded)
  const context = createDiscoveryContext()
  const entries: AgentInvocationStreamEntry[] = []
  for (const { agent, aliases, definition } of loaded) {
    const triggers = await resolveAgentTriggers(agent as never, context as never)
    entries.push({ agent, ...(aliases ? { aliases } : {}), name: definition.name, triggers })
  }
  return entries
}

function selectedEntry(entries: AgentInvocationStreamEntry[], name: string | undefined): AgentInvocationStreamEntry {
  if (name) {
    const entry = entries.find(item => item.name === name)
      ?? entries.find(item => item.aliases?.includes(name))
    if (!entry) throw new Response(`Unknown Agent Dev Loop Target: ${name}`, { status: 404 })
    return entry
  }
  if (entries.length === 1) return entries[0]!
  if (entries.length === 0) throw new Response("No Agents discovered.", { status: 404 })
  throw new Response(`Multiple Agents discovered. Pass --agent ${entries.map(item => item.name).join("|")}.`, { status: 400 })
}

function messageFromText(text: string): AgentChatMessageTriggerInput["messages"][number] {
  return {
    id: `dev-${Date.now()}`,
    parts: [{ text, type: "text" }],
    role: "user",
  }
}

function messagesFromBody(body: AgentInvocationStreamBody): AgentChatMessageTriggerInput["messages"] {
  if (Array.isArray(body.messages) && body.messages.length) return body.messages
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (text) return [messageFromText(text)]
  throw new Response("Missing Agent Dev Loop message text.", { status: 400 })
}

function textFromUiMessage(message: AgentChatMessageTriggerInput["messages"][number]): string {
  return (Array.isArray(message.parts) ? message.parts : [])
    .filter((part): part is { text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("")
}

function promptFromBody(body: AgentInvocationStreamBody): string | undefined {
  if (typeof body.text === "string" && body.text.trim()) return body.text
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== "user") continue
    const text = textFromUiMessage(message)
    if (text.trim()) return text
  }
  const text = messages.length ? textFromUiMessage(messages.at(-1)!) : undefined
  return text?.trim() ? text : undefined
}

function selectedTrigger(entry: AgentInvocationStreamEntry, body: AgentInvocationStreamBody): ResolvedAgentTriggerDefinition | undefined {
  if (typeof body.trigger === "string" && body.trigger.trim()) {
    const trigger = entry.triggers[body.trigger]
    if (!trigger) throw new Response(`Unknown Agent Trigger: ${body.trigger}`, { status: 404 })
    return trigger
  }
  return entry.triggers["chat.message"]
}

function triggerInput(trigger: ResolvedAgentTriggerDefinition, body: AgentInvocationStreamBody, signal: AbortSignal, run: AgentRunMetadata, timeout: number): unknown {
  const payload = payloadFromBody(body)
  if (trigger.id !== "chat.message") {
    const prompt = promptFromBody(body)
    if (payload) {
      return withDevLoopControls(withPayloadDefaults(payload, {
        ...(prompt ? { prompt } : {}),
        ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
        ...(isRecord(body.meta) ? { meta: body.meta } : {}),
        run,
      }) as AgentRunInput<unknown>, signal, timeout)
    }
    if (!prompt) throw new Response("Missing Agent Trigger payload. Pass --payload or prompt.", { status: 400 })
    return {
      abortSignal: signal,
      prompt,
      run,
      timeout,
      ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
      ...(isRecord(body.meta) ? { meta: body.meta } : {}),
    }
  }
  const messages = payload && Array.isArray(payload.messages) && payload.messages.length
    ? undefined
    : messagesFromBody(body)
  return withDevLoopControls(withPayloadDefaults(payload || {}, {
    ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
    ...(isRecord(body.meta) ? { meta: body.meta } : {}),
    ...(messages ? { messages } : {}),
    run,
    user: {
      id: "dev",
      name: "ViteHub Dev Loop",
    },
  }) as unknown as AgentChatMessageTriggerInput, signal, timeout)
}

function parseBody(rawBody: string): AgentInvocationStreamBody {
  if (!rawBody.trim()) return {}
  try {
    const body = JSON.parse(rawBody)
    return isRecord(body) ? body : {}
  }
  catch {
    throw new Response("Malformed Agent Invocation Stream payload.", { status: 400 })
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = ""
  req.setEncoding("utf8")
  for await (const chunk of req) body += chunk
  return body
}

function devRun(agent: string): AgentRunMetadata {
  return {
    origin: "dev",
    runId: `dev:${globalThis.crypto.randomUUID()}`,
    threadId: `dev:${agent}`,
  }
}

function withCapabilityCliRun(agent: AgentInput, cli: string, execution: AgentCapabilityCliExecutionInput): AgentInput {
  const clone = Object.create(Object.getPrototypeOf(agent)) as AgentInput
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(agent))
  clone.run = async (context) => {
    const tool = context.tools?.[cli]
    if (!tool || tool.metadata?.vitehubCapabilityCli !== true || typeof tool.execute !== "function") {
      throw new Error(`[vitehub] Agent Capability CLI "${cli}" is not defined by this agent.`)
    }
    return await tool.execute(execution) as AgentCapabilityCliExecutionResult
  }
  return clone
}

async function handleAgentInvocationStreamRequest(server: ViteDevServer, req: IncomingMessage): Promise<Response> {
  const entries = await discoverStreamAgents(server)
  if (req.method === "GET") {
    return Response.json({
      agents: entries.map(entry => ({
        ...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
        name: entry.name,
        triggers: Object.keys(entry.triggers),
      })),
      root: server.config.root,
    })
  }

  const body = parseBody(await readRequestBody(req))
  const entry = selectedEntry(entries, body.agent)
  const run = body.run || devRun(entry.name)
  const context = createRuntimeContext(server, req, run)
  const payload = payloadFromBody(body)
  const timeout = typeof body.timeout === "number" && Number.isFinite(body.timeout) ? body.timeout : 90_000

  if (body.cli) {
    if (typeof body.cli.name !== "string" || !body.cli.name.trim()) {
      return new Response("Missing Agent Capability CLI name.", { status: 400 })
    }
    return Response.json(await runAgentInline(withCapabilityCliRun(entry.agent as never, body.cli.name, {
      argv: Array.isArray(body.cli.argv) ? body.cli.argv : [],
      ...(body.cli.input !== undefined ? { input: body.cli.input } : {}),
      ...(body.cli.json !== undefined ? { json: body.cli.json } : {}),
    }) as never, context as never, {
      abortSignal: AbortSignal.timeout(timeout),
      ...(payload ? { context: payload } : {}),
      timeout,
    }) as AgentCapabilityCliExecutionResult)
  }

  return createAgentInvocationStreamResponse(async (emit, signal) => {
    let output: Awaited<ReturnType<typeof streamAgent>>
    const trigger = selectedTrigger(entry, body)
    if (trigger) {
      const triggerContext = { ...context, request: undefined }
      const invocation = await resolveAgentTriggerInvocation(entry.agent as never, triggerContext as never, trigger.id, triggerInput(trigger, body, signal, run, timeout))
      if (isResolvedAgentTriggerHandledInvocation(invocation)) {
        output = invocation.response
      }
      else {
        if (!signal.aborted) emit({ agent: entry.name, ...(invocation.metadata ? { metadata: invocation.metadata } : {}), run: invocation.run, trigger: invocation.trigger.id, type: "start" })
        const previewAgent = withDeliveryPreviewChannels(entry.agent, event => {
          if (!signal.aborted) emit(event)
        })
        output = await streamAgent(previewAgent as never, { ...context, ...(invocation.run ? { run: invocation.run } : {}) } as never, withDevLoopControls(invocation.input, signal, timeout) as never, {
          output: "events",
        })
      }
    }
    else {
      const messages = messagesFromBody(body)
      if (!signal.aborted) emit({ agent: entry.name, run, type: "start" })
      const previewAgent = withDeliveryPreviewChannels(entry.agent, event => {
        if (!signal.aborted) emit(event)
      })
      output = await streamAgent(previewAgent as never, context as never, {
        ...payload,
        abortSignal: signal,
        ...(typeof body.invokerProfileId === "string" && payload?.invokerProfileId === undefined
          ? { context: { ...(isRecord(payload?.context) ? payload.context : {}), invokerProfileId: body.invokerProfileId } }
          : {}),
        messages: uiMessagesToAgentMessages(messages),
        timeout,
      }, { output: "events" })
    }
    for await (const event of streamAgentOutputToEvents(output)) {
      if (signal.aborted) return
      emit(event)
    }
  }, { timeout })
}

function routeMatches(req: IncomingMessage): boolean {
  return new URL(req.url || "/", "http://localhost").pathname === agentInvocationStreamRoute
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
  let closed = false
  const cancel = () => {
    if (!closed) void reader.cancel().catch(() => {})
  }
  res.once("close", cancel)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    closed = true
    res.end()
  }
  catch (error) {
    closed = true
    res.destroy(error instanceof Error ? error : undefined)
  }
  finally {
    closed = true
    res.off("close", cancel)
    reader.releaseLock()
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof Response) return error
  return new Response(error instanceof Error ? error.message : "Agent Invocation Stream endpoint failed.", {
    status: 500,
  })
}

export function registerAgentInvocationStreamEndpoint(server: ViteDevServer): void {
  server.middlewares.use((req, res, next) => {
    if (!routeMatches(req)) {
      next()
      return
    }
    if (req.method !== "GET" && req.method !== "POST") {
      void writeResponse(res, new Response("Method not allowed.", { status: 405 }))
      return
    }
    const blocked = validateDevLoopRequest(server, req)
    if (blocked) {
      void writeResponse(res, blocked)
      return
    }

    void handleAgentInvocationStreamRequest(server, req)
      .catch(errorResponse)
      .then(response => writeResponse(res, response))
  })
}
