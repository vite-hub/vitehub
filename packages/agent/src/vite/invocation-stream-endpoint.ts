import { join } from "node:path"

import { createGitHubWorkspaceStore } from "@vite-hub/workspace/internal/stores/github"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { installHostedWorkspaceRuntime } from "@vite-hub/workspace/internal/runtime/hosted"
import { installHostedVercelBlobWorkspaceRuntime } from "@vite-hub/workspace/internal/runtime/hosted-vercel-blob"
import { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader, setWorkspaceRuntimeRegistry } from "@vite-hub/workspace/runtime"
import { ensureWorkspaceDevToken, refreshWorkspaceDevToken, runWorkspaceDevCommand, validateWorkspaceDevToken, workspaceDevTokenServerId } from "@vite-hub/workspace/server"

import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute, createAgentInvocationStreamResponse } from "../invocation-stream.ts"
import { streamAgentOutputToEvents } from "../agent-output.ts"
import { uiMessagesToAgentMessages } from "../chat-message-input.ts"
import { discoverAgentDefinitions } from "../discovery.ts"
import { isResolvedAgentTriggerHandledInvocation, resolveAgentInspectionMetadata, resolveAgentTriggerInvocation, resolveAgentTriggers, runAgentInline, streamAgent } from "../index.ts"
import { inheritMessageChannelInstructions } from "../internal/channels.ts"
import { workspaceAgentOwnsWorkspaceDefinition, workspaceModeFromOptions, workspaceNameFromOptions } from "../workspace-agent.ts"
import {
  createViteAgentDiscoveryContext,
  createViteAgentRuntimeContext,
  createViteWorkspaceAgentLoader,
  loadViteAgent,
  writeViteResponse as writeResponse,
} from "./runtime-adapter.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteDevServer } from "vite"
import type { AgentChatMessageTriggerInput } from "../chat-trigger.ts"
import type { AgentDevLoopDiscoveryResponse, AgentInvocationStreamEvent } from "../invocation-stream.ts"
import type {
  AgentChannelDeliveryEffectContext,
  AgentCapabilityCliExecutionInput,
  AgentCapabilityCliExecutionResult,
  AgentHostIdentity,
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  DiscoveredAgentDefinition,
  ResolvedAgentTriggerDefinition,
} from "../index.ts"
import type { WorkspaceDevTokenOptions } from "@vite-hub/workspace/server"
import type { ViteAgentRuntimeContext } from "./runtime-adapter.ts"

const capabilityCliRunSurface = Symbol.for("vitehub.capabilityCliRunSurface")
const workspaceRegistryId = "#vitehub-workspace-registry"

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
  workspaceCommand?: {
    args?: unknown
    command?: unknown
    timeout?: unknown
  }
}

interface AgentInvocationStreamEntry {
  agent: AgentInput<ViteAgentRuntimeContext>
  aliases?: string[]
  identity: AgentHostIdentity
  name: string
  triggers: Record<string, ResolvedAgentTriggerDefinition<ViteAgentRuntimeContext>>
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

function withDevLoopAbortSignal<TInput extends object>(
  input: TInput,
  signal: AbortSignal,
): TInput & { abortSignal: AbortSignal } {
  return {
    ...input,
    abortSignal: signal,
  }
}

function withPayloadDefaults(payload: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const input = { ...payload }
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined && input[key] === undefined) input[key] = value
  }
  return input
}

function createAbortSignalFromClose(target: Pick<IncomingMessage | ServerResponse, "off" | "once">, message: string): { dispose: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error(message))
  target.once("close", abort)
  return {
    dispose: () => target.off("close", abort),
    signal: controller.signal,
  }
}

function linkAbortSignal(controller: AbortController, parent?: AbortSignal): () => void {
  if (!parent) return () => {}
  const abort = () => controller.abort(parent.reason)
  parent.addEventListener("abort", abort, { once: true })
  if (parent.aborted) abort()
  return () => parent.removeEventListener("abort", abort)
}

function createWorkspaceCommandAbortSignal(req: IncomingMessage, parent?: AbortSignal): { dispose: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  const close = () => controller.abort(new Error("[vitehub] Agent Dev Loop command request closed."))
  req.once("close", close)
  const unlink = linkAbortSignal(controller, parent)
  return {
    dispose() {
      req.off("close", close)
      unlink()
    },
    signal: controller.signal,
  }
}

function withDeliveryPreviewChannels(
  agent: AgentInput<ViteAgentRuntimeContext>,
  preview: (event: Extract<AgentInvocationStreamEvent, { type: "delivery-preview" }>) => void,
): AgentInput<ViteAgentRuntimeContext> {
  if (!isRecord(agent) || !isRecord(agent.channels)) return agent
  const channels = Object.fromEntries(Object.entries(agent.channels).map(([channelId, channel]) => {
    if (!isRecord(channel) || !isRecord(channel.effects)) return [channelId, channel]
    const effects = Object.fromEntries(Object.keys(channel.effects).map(kind => [kind, (context: AgentChannelDeliveryEffectContext<AgentRuntimeConfig>) => {
      preview({
        channelId: context.trigger?.channelId || context.run?.channelId || channelId,
        effect: context.effect,
        ...(context.run ? { run: context.run } : {}),
        type: "delivery-preview",
      })
    }]))
    return [channelId, inheritMessageChannelInstructions({ ...channel, effects }, channel)]
  }))
  const clone = Object.create(Object.getPrototypeOf(agent)) as AgentInput<ViteAgentRuntimeContext>
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(agent))
  Object.defineProperty(clone, "channels", {
    configurable: true,
    enumerable: true,
    value: channels,
    writable: true,
  })
  return clone
}

function formatCliDeliveryPreview(event: Extract<AgentInvocationStreamEvent, { type: "delivery-preview" }>): string {
  const details = {
    ...(event.effect.intent !== undefined ? { intent: event.effect.intent } : {}),
    ...(event.effect.payload !== undefined ? { payload: event.effect.payload } : {}),
    ...(event.effect.metadata !== undefined ? { metadata: event.effect.metadata } : {}),
  }
  const extra = Object.keys(details).length ? `\n${JSON.stringify(details, null, 2)}` : ""
  return `\n[delivery preview] would ${event.effect.kind}${event.channelId ? ` on ${event.channelId}` : ""}${extra}\n`
}

function withCliDeliveryPreviews(
  result: AgentCapabilityCliExecutionResult,
  previews: Array<Extract<AgentInvocationStreamEvent, { type: "delivery-preview" }>>,
): AgentCapabilityCliExecutionResult {
  if (!previews.length) return result
  return {
    ...result,
    stderr: `${result.stderr || ""}${previews.map(formatCliDeliveryPreview).join("")}`,
  }
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

function declaredAgentName(agent: AgentInput<ViteAgentRuntimeContext> | undefined): string | undefined {
  if (typeof agent?.name === "string" && agent.name) return agent.name
  const options = isRecord(agent) && isRecord(agent.__vitehubWorkspaceAgentOptions) ? agent.__vitehubWorkspaceAgentOptions : undefined
  return typeof options?.name === "string" && options.name ? options.name : undefined
}

function agentAliases(definition: DiscoveredAgentDefinition, agent: AgentInput<ViteAgentRuntimeContext>): string[] | undefined {
  const declaredName = declaredAgentName(agent)
  return declaredName && declaredName !== definition.name ? [declaredName] : undefined
}

type WorkspaceRegistry = Parameters<typeof setWorkspaceRuntimeRegistry>[0]

function isWorkspaceRegistry(value: unknown): value is WorkspaceRegistry {
  return isRecord(value) && Object.values(value).every(item => typeof item === "function")
}

function hasHostedWorkspaceStore(agent: AgentInput<ViteAgentRuntimeContext>): boolean {
  const options = isRecord(agent) && isRecord(agent.__vitehubWorkspaceAgentOptions) ? agent.__vitehubWorkspaceAgentOptions : undefined
  const workspace = typeof options?.workspace === "string" || isRecord(options?.workspace) ? options.workspace : undefined
  const store = isRecord(workspace) && isRecord(workspace.store) ? workspace.store : undefined
  if (!workspace) return false
  return store?.provider === "cloudflare-artifacts" || store?.provider === "github"
}

function hasHostedVercelBlobWorkspaceStore(agent: AgentInput<ViteAgentRuntimeContext>): boolean {
  const options = isRecord(agent) && isRecord(agent.__vitehubWorkspaceAgentOptions) ? agent.__vitehubWorkspaceAgentOptions : undefined
  const workspace = typeof options?.workspace === "string" || isRecord(options?.workspace) ? options.workspace : undefined
  const store = isRecord(workspace) && isRecord(workspace.store) ? workspace.store : undefined
  if (!workspace) return false
  if (!store && typeof process === "object" && process?.env?.BLOB_READ_WRITE_TOKEN) return true
  return store?.provider === "vercel-blob"
}

async function loadViteWorkspaceRegistry(server: ViteDevServer): Promise<WorkspaceRegistry> {
  if (!server.config.plugins?.some(plugin => plugin.name === "@vite-hub/workspace/vite")) return {}
  const mod = await server.ssrLoadModule(workspaceRegistryId) as { default?: unknown }
  return isWorkspaceRegistry(mod.default) ? mod.default : {}
}

async function installServerAgentWorkspaceRegistry(
  server: ViteDevServer,
  entries: Array<{ agent: AgentInput<ViteAgentRuntimeContext>, aliases?: string[], definition: DiscoveredAgentDefinition }>,
): Promise<WorkspaceRegistry> {
  const registry = {
    ...await loadViteWorkspaceRegistry(server),
    ...Object.fromEntries(entries
    .filter(entry => entry.definition.workspace && workspaceAgentOwnsWorkspaceDefinition(entry.agent))
    .flatMap(({ aliases, definition }) => [definition.workspace!, ...(aliases || [])].map(name => [
      name,
      createViteWorkspaceAgentLoader(server, definition),
    ]))),
  } satisfies WorkspaceRegistry
  if (entries.some(({ agent }) => hasHostedWorkspaceStore(agent))) installHostedWorkspaceRuntime()
  if (entries.some(({ agent }) => hasHostedVercelBlobWorkspaceStore(agent))) installHostedVercelBlobWorkspaceRuntime()
  const existingWorkspaceHostedStoreLoader = getWorkspaceHostedStoreLoader()
  setWorkspaceHostedStoreLoader((storeOptions, workspaceName) => {
    if (storeOptions.provider === "github") return createGitHubWorkspaceStore(storeOptions, workspaceName)
    if (existingWorkspaceHostedStoreLoader) return existingWorkspaceHostedStoreLoader(storeOptions, workspaceName)
    throw new Error(`[vitehub] Hosted workspace store "${storeOptions.provider}" is not available in this runtime.`)
  })
  setWorkspaceRuntimeRegistry(registry)
  return registry
}

async function discoverStreamAgents(server: ViteDevServer): Promise<AgentInvocationStreamEntry[]> {
  const serverDirs = (server.config as typeof server.config & {
    [VITEHUB_SERVER_DIRS]?: string[]
  })[VITEHUB_SERVER_DIRS] ?? [join(server.config.root, "server")]
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
  })
  const loaded = []
  for (const definition of definitions) {
    const entry = await loadViteAgent(server, definition)
    if (entry) loaded.push({ ...entry, aliases: agentAliases(definition, entry.agent) })
  }
  await installServerAgentWorkspaceRegistry(server, loaded)
  const entries: AgentInvocationStreamEntry[] = []
  for (const { agent, aliases, definition, identity } of loaded) {
    const context = createViteAgentDiscoveryContext(identity)
    const triggers = await resolveAgentTriggers(agent as never, context as never)
    entries.push({ agent, ...(aliases ? { aliases } : {}), identity, name: definition.name, triggers })
  }
  return entries
}

function agentWorkspaceName(entry: AgentInvocationStreamEntry): string | undefined {
  const agent = entry.agent as Partial<{
    __vitehubWorkspaceAgentOptions: Parameters<typeof workspaceNameFromOptions>[0]
  }>
  return agent.__vitehubWorkspaceAgentOptions
    ? workspaceNameFromOptions(agent.__vitehubWorkspaceAgentOptions, {}, entry.identity)
    : undefined
}

function agentWorkspaceOptions(entry: AgentInvocationStreamEntry) {
  const agent = entry.agent as Partial<{
    __vitehubWorkspaceAgentOptions: Parameters<typeof workspaceNameFromOptions>[0]
  }>
  return agent.__vitehubWorkspaceAgentOptions
    ? { options: agent.__vitehubWorkspaceAgentOptions }
    : undefined
}

function agentWorkspaceMode(entry: AgentInvocationStreamEntry): "read" | "write" {
  const workspace = agentWorkspaceOptions(entry)
  return workspace ? workspaceModeFromOptions(workspace.options as never) : "read"
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

function triggerInput(trigger: ResolvedAgentTriggerDefinition, body: AgentInvocationStreamBody, signal: AbortSignal, run: AgentRunMetadata): unknown {
  const payload = payloadFromBody(body)
  if (trigger.id !== "chat.message") {
    const prompt = promptFromBody(body)
    if (payload) {
      return withDevLoopAbortSignal(withPayloadDefaults(payload, {
        ...(prompt ? { prompt } : {}),
        ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
        ...(isRecord(body.meta) ? { meta: body.meta } : {}),
        run,
      }) as AgentRunInput<unknown>, signal)
    }
    if (!prompt) throw new Response("Missing Agent Trigger payload. Pass --payload or prompt.", { status: 400 })
    return {
      abortSignal: signal,
      prompt,
      run,
      ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
      ...(isRecord(body.meta) ? { meta: body.meta } : {}),
    }
  }
  const messages = Array.isArray(body.messages) && body.messages.length
    ? messagesFromBody(body)
    : payload && Array.isArray(payload.messages) && payload.messages.length
      ? undefined
      : messagesFromBody(body)
  const input = withPayloadDefaults(payload || {}, {
    ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
    ...(isRecord(body.meta) ? { meta: body.meta } : {}),
    run,
    user: {
      id: "dev",
      name: "ViteHub Dev Loop",
    },
  })
  return withDevLoopAbortSignal({
    ...input,
    ...(messages ? { messages } : {}),
  } as unknown as AgentChatMessageTriggerInput, signal)
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

async function streamAgentWithWorkspaceProgress(
  entry: AgentInvocationStreamEntry,
  emit: (event: AgentInvocationStreamEvent) => void,
  signal: AbortSignal,
  run: () => ReturnType<typeof streamAgent>,
): ReturnType<typeof streamAgent> {
  const workspace = agentWorkspaceName(entry)
  if (!workspace) return await run()

  const startedAt = Date.now()
  const id = `workspace.prepare:${workspace}`
  const label = "Preparing workspace"
  if (!signal.aborted) emit({ data: { workspace }, id, label, phase: "workspace.prepare", status: "started", type: "progress" })
  try {
    const output = await run()
    if (!signal.aborted) emit({ data: { workspace }, durationMs: Date.now() - startedAt, id, label, phase: "workspace.prepare", status: "completed", type: "progress" })
    return output
  }
  catch (error) {
    if (!signal.aborted) {
      emit({
        data: {
          error: "Workspace preparation failed.",
          workspace,
        },
        durationMs: Date.now() - startedAt,
        id,
        label,
        phase: "workspace.prepare",
        status: "failed",
        type: "progress",
      })
    }
    throw error
  }
}

function exposesCapabilityCli(agent: AgentInput): boolean {
  const cli = (agent as { cli?: { capabilities?: boolean } }).cli
  return cli?.capabilities !== false
}

function withCapabilityCliRun(agent: AgentInput, cli: string, execution: AgentCapabilityCliExecutionInput): AgentInput {
  const clone = Object.create(Object.getPrototypeOf(agent)) as AgentInput
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(agent))
  if (exposesCapabilityCli(agent)) Object.defineProperty(clone, capabilityCliRunSurface, { value: true })
  clone.run = async (context) => {
    const tool = context.tools?.[cli]
    if (!tool || tool.metadata?.vitehubCapabilityCli !== true || typeof tool.execute !== "function") {
      throw new Error(`[vitehub] Agent Capability CLI "${cli}" is not defined by this agent.`)
    }
    return await tool.execute(execution) as AgentCapabilityCliExecutionResult
  }
  return clone
}

function withWorkspaceCommandRun(agent: AgentInput, command: { abortSignal?: AbortSignal, args?: string[], command: string, timeout?: number }): AgentInput {
  const clone = Object.create(Object.getPrototypeOf(agent)) as AgentInput
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(agent))
  clone.run = async (context) => {
    if (!context.workspace) throw new Error("[vitehub] Agent Dev Loop command requires an Agent with a Workspace.")
    const { resolveBox } = await import("@vite-hub/" + "box") as typeof import("@vite-hub/box")
    const host = await (await resolveBox({ runtime: "trusted-host" }, {})).open({ signal: command.abortSignal })
    try {
      return await runWorkspaceDevCommand({
        abortSignal: command.abortSignal,
        ...(command.args ? { args: command.args } : {}),
        command: command.command,
        host,
        timeout: command.timeout,
        workspace: context.workspace as never,
      })
    }
    finally {
      await host.close()
    }
  }
  return clone
}

async function runCapabilityCliWithTimeout(
  agent: AgentInput,
  cli: string,
  execution: AgentCapabilityCliExecutionInput,
  context: ViteAgentRuntimeContext,
  input: AgentRunInput<unknown>,
  timeout: number,
  abortSignal?: AbortSignal,
): Promise<Response | AgentCapabilityCliExecutionResult> {
  const controller = new AbortController()
  const unlink = linkAbortSignal(controller, abortSignal)
  const run = runAgentInline(withCapabilityCliRun(agent, cli, execution) as never, context as never, {
    ...input,
    abortSignal: controller.signal,
    timeout,
  }, { output: "raw" }) as Promise<Response | AgentCapabilityCliExecutionResult>

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    if (timeout <= 0) return await run
    const timedOut = new Promise<Response>((resolve) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`Agent Invocation Stream timed out after ${timeout}ms.`)
        controller.abort(error)
        resolve(new Response(error.message, { status: 504 }))
      }, timeout)
    })
    return await Promise.race([run, timedOut])
  }
  finally {
    if (timeoutId) clearTimeout(timeoutId)
    unlink()
  }
}

async function handleAgentInvocationStreamRequest(server: ViteDevServer, req: IncomingMessage, tokenOptions: WorkspaceDevTokenOptions, abortSignal?: AbortSignal): Promise<Response> {
  const entries = await discoverStreamAgents(server)
  if (req.method === "GET") {
    await ensureWorkspaceDevToken(server.config.root, tokenOptions)
    const url = new URL(req.url || "/", "http://localhost")
    const inspect = url.searchParams.get("inspect") === "1"
    const entry = inspect ? selectedEntry(entries, url.searchParams.get("agent") || undefined) : undefined
    const run = entry ? devRun(entry.name) : undefined
    const inspection = entry && run
      ? await resolveAgentInspectionMetadata(entry.agent as never, {
          input: {
            context: { invoker: { id: "inspection", kind: "inspection" } },
            messages: [],
          },
          runtime: createViteAgentRuntimeContext(server, req, entry.identity, { fallbackRoute: agentInvocationStreamRoute, run }),
        })
      : undefined
    const response = {
      agents: entries.map(entry => ({
        ...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
        name: entry.name,
        triggers: Object.keys(entry.triggers),
      })),
      ...(inspection && entry ? { inspection: { ...inspection, name: entry.name } } : {}),
      root: server.config.root,
      workspaceDevTokenServerId: tokenOptions.serverId,
    } satisfies AgentDevLoopDiscoveryResponse
    return Response.json(response)
  }

  const body = parseBody(await readRequestBody(req))
  const entry = selectedEntry(entries, body.agent)
  const run = body.run || devRun(entry.name)
  const context = createViteAgentRuntimeContext(server, req, entry.identity, { fallbackRoute: agentInvocationStreamRoute, run })
  const payload = payloadFromBody(body)
  const timeout = typeof body.timeout === "number" && Number.isFinite(body.timeout) ? body.timeout : 90_000

  if (body.cli) {
    if (typeof body.cli.name !== "string" || !body.cli.name.trim()) {
      return new Response("Missing Agent Capability CLI name.", { status: 400 })
    }
    const previews: Array<Extract<AgentInvocationStreamEvent, { type: "delivery-preview" }>> = []
    const previewAgent = withDeliveryPreviewChannels(entry.agent, event => previews.push(event))
    const result = await runCapabilityCliWithTimeout(previewAgent as never, body.cli.name, {
      argv: Array.isArray(body.cli.argv) ? body.cli.argv : [],
      ...(body.cli.input !== undefined ? { input: body.cli.input } : {}),
      ...(body.cli.json !== undefined ? { json: body.cli.json } : {}),
    }, context, {
      context: withPayloadDefaults(payload || {}, {
        ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
        ...(isRecord(body.meta) ? { meta: body.meta } : {}),
      }),
    }, timeout, abortSignal)
    if (result instanceof Response) return result
    return Response.json(withCliDeliveryPreviews(result, previews))
  }

  if (body.workspaceCommand) {
    const workspace = agentWorkspaceName(entry)
    if (!workspace) return new Response("Agent Dev Loop command requires an Agent with a Workspace.", { status: 400 })
    if (agentWorkspaceMode(entry) !== "write") {
      return new Response("Agent Dev Loop command requires workspace.mode: \"write\".", { status: 403 })
    }
    if (!await validateWorkspaceDevToken(server.config.root, req.headers, tokenOptions)) {
      return new Response("Forbidden Agent Dev Loop command token.", { status: 403 })
    }
    if (typeof body.workspaceCommand.command !== "string") {
      return new Response("Missing Agent Dev Loop command.", { status: 400 })
    }
    if (body.workspaceCommand.args !== undefined && (!Array.isArray(body.workspaceCommand.args) || body.workspaceCommand.args.some(arg => typeof arg !== "string"))) {
      return new Response("Agent Dev Loop command args must be strings.", { status: 400 })
    }
    const args = body.workspaceCommand.args as string[] | undefined
    const commandTimeout = typeof body.workspaceCommand.timeout === "number" && Number.isFinite(body.workspaceCommand.timeout)
      ? body.workspaceCommand.timeout
      : timeout
    const commandAbort = createWorkspaceCommandAbortSignal(req, abortSignal)
    try {
      const result = await runAgentInline(withWorkspaceCommandRun(entry.agent, {
        abortSignal: commandAbort.signal,
        ...(args ? { args } : {}),
        command: body.workspaceCommand.command,
        timeout: commandTimeout,
      }) as never, context as never, {
        abortSignal: commandAbort.signal,
        context: withPayloadDefaults(payload || {}, {
          ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
          ...(isRecord(body.meta) ? { meta: body.meta } : {}),
        }),
      }, { output: "raw" })
      if (result instanceof Response) return result
      return Response.json(result)
    }
    finally {
      commandAbort.dispose()
    }
  }

  return createAgentInvocationStreamResponse(async (emit, signal) => {
    let output: Awaited<ReturnType<typeof streamAgent>>
    const trigger = selectedTrigger(entry, body)
    if (trigger) {
      const triggerContext = { ...context, request: undefined }
      const invocation = await resolveAgentTriggerInvocation(entry.agent as never, triggerContext as never, trigger.id, triggerInput(trigger, body, signal, run))
      if (isResolvedAgentTriggerHandledInvocation(invocation)) {
        output = invocation.response
      }
      else {
        if (!signal.aborted) emit({ agent: entry.name, ...(invocation.metadata ? { metadata: invocation.metadata } : {}), run: invocation.run, trigger: invocation.trigger.id, type: "start" })
        const previewAgent = withDeliveryPreviewChannels(entry.agent, event => {
          if (!signal.aborted) emit(event)
        })
        output = await streamAgentWithWorkspaceProgress(entry, emit, signal, async () => await streamAgent(previewAgent as never, { ...context, ...(invocation.run ? { run: invocation.run } : {}) } as never, withDevLoopAbortSignal(invocation.input, signal) as never, {
          output: "events",
        }))
      }
    }
    else {
      const messages = messagesFromBody(body)
      if (!signal.aborted) emit({ agent: entry.name, run, type: "start" })
      const previewAgent = withDeliveryPreviewChannels(entry.agent, event => {
        if (!signal.aborted) emit(event)
      })
      output = await streamAgentWithWorkspaceProgress(entry, emit, signal, async () => await streamAgent(previewAgent as never, context as never, {
        ...payload,
        abortSignal: signal,
        ...(typeof body.invokerProfileId === "string" && payload?.invokerProfileId === undefined
          ? { context: { ...(isRecord(payload?.context) ? payload.context : {}), invokerProfileId: body.invokerProfileId } }
          : {}),
        messages: uiMessagesToAgentMessages(messages),
      }, { output: "events" }))
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

export { writeResponse }

function errorResponse(error: unknown): Response {
  if (error instanceof Response) return error
  return new Response("Agent Invocation Stream endpoint failed.", {
    status: 500,
  })
}

export async function registerAgentInvocationStreamEndpoint(server: ViteDevServer): Promise<void> {
  const tokenOptions = { serverId: workspaceDevTokenServerId(server.config.server.port) }
  await refreshWorkspaceDevToken(server.config.root, tokenOptions)
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

    const abort = createAbortSignalFromClose(res, "[vitehub] Agent Invocation Stream response closed.")
    void handleAgentInvocationStreamRequest(server, req, tokenOptions, abort.signal)
      .catch(errorResponse)
      .then(response => writeResponse(res, response))
      .finally(abort.dispose)
  })
}
