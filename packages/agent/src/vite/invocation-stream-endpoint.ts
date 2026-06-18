import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { setWorkspaceRuntimeRegistry } from "@vite-hub/workspace/internal/runtime/state"

import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute, createAgentInvocationStreamResponse } from "../invocation-stream.ts"
import { streamAgentOutputToEvents } from "../agent-output.ts"
import { discoverAgentDefinitions } from "../discovery.ts"
import { resolveAgentTriggers, streamAgentTrigger, withWorkspaceAgentDefaults } from "../index.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import type { ViteDevServer } from "vite"
import type { AgentChatMessageTriggerInput } from "../chat-trigger.ts"
import type {
  AgentInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  DiscoveredAgentDefinition,
  WorkspaceAgentDefaults,
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
  invokerProfileId?: string
  messages?: AgentChatMessageTriggerInput["messages"]
  meta?: Record<string, unknown>
  run?: AgentRunMetadata
  text?: string
  timeout?: number
}

interface AgentInvocationStreamEntry {
  agent: AgentInput<ViteAgentDevRuntimeContext>
  name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
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
        return {
          ...mod,
          default: {
            ...mod.default,
            sourceRootDir: mod.default?.sourceRootDir ?? resolveWorkspaceSourceRoot(definition.handler),
          },
        }
      },
    ])))
}

async function loadDiscoveredAgent(
  server: ViteDevServer,
  definition: DiscoveredAgentDefinition,
): Promise<AgentInput<ViteAgentDevRuntimeContext> | undefined> {
  const module = await server.ssrLoadModule(pathToFileURL(definition.handler).href)
  const agent = resolveAgentModule(module)
  const defaults = workspaceDefaults(definition)
  return agent && defaults
    ? withWorkspaceAgentDefaults(agent as never, defaults as never) as AgentInput<ViteAgentDevRuntimeContext>
    : agent
}

async function discoverStreamAgents(server: ViteDevServer): Promise<AgentInvocationStreamEntry[]> {
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(server.config.root, "server")],
  })
  installServerAgentWorkspaceRegistry(server, definitions)
  const context = createDiscoveryContext()
  const entries: AgentInvocationStreamEntry[] = []
  for (const definition of definitions) {
    const agent = await loadDiscoveredAgent(server, definition)
    if (!agent) continue
    const triggers = await resolveAgentTriggers(agent as never, context as never)
    if (triggers["chat.message"]) {
      entries.push({ agent, name: definition.name })
    }
  }
  return entries
}

function selectedEntry(entries: AgentInvocationStreamEntry[], name: string | undefined): AgentInvocationStreamEntry {
  if (name) {
    const entry = entries.find(item => item.name === name)
    if (!entry) throw new Response(`Unknown Agent Dev Loop Target: ${name}`, { status: 404 })
    return entry
  }
  if (entries.length === 1) return entries[0]!
  if (entries.length === 0) throw new Response("No Agents expose the chat.message trigger.", { status: 404 })
  throw new Response(`Multiple Agents expose chat.message. Pass --agent ${entries.map(item => item.name).join("|")}.`, { status: 400 })
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

async function handleAgentInvocationStreamRequest(server: ViteDevServer, req: IncomingMessage): Promise<Response> {
  const entries = await discoverStreamAgents(server)
  if (req.method === "GET") {
    return Response.json({
      agents: entries.map(entry => ({ name: entry.name, triggers: ["chat.message"] })),
      root: server.config.root,
    })
  }

  const body = parseBody(await readRequestBody(req))
  const entry = selectedEntry(entries, body.agent)
  const run = body.run || devRun(entry.name)
  const context = createRuntimeContext(server, req, run)
  const messages = messagesFromBody(body)

  return createAgentInvocationStreamResponse(async (emit, signal) => {
    const input: AgentChatMessageTriggerInput = {
      abortSignal: signal,
      messages,
      run,
      timeout: typeof body.timeout === "number" && Number.isFinite(body.timeout) ? body.timeout : 90_000,
      user: {
        id: "dev",
        name: "ViteHub Dev Loop",
      },
      ...(typeof body.invokerProfileId === "string" ? { invokerProfileId: body.invokerProfileId } : {}),
      ...(isRecord(body.meta) ? { meta: body.meta } : {}),
    }
    const output = await streamAgentTrigger(entry.agent as never, context as never, "chat.message", input, {
      async onInvocation(invocation) {
        if (!signal.aborted) emit({ agent: entry.name, run: invocation.run, trigger: invocation.trigger.id, type: "start" })
      },
      output: "events",
    })
    for await (const event of streamAgentOutputToEvents(output)) {
      if (signal.aborted) return
      emit(event)
    }
  })
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
