import { createError, defineEventHandler, getRouterParam } from "h3"

import { resolveAgent, runAgent, streamAgent } from "../index.ts"
import { isChatCapability } from "../chat/capability.ts"
import { createChatBot } from "../chat/runtime/agent-chat.ts"
import { createMemoryChatStateAdapter, createWorkspaceChatStateAdapter } from "../chat/runtime/workspace-state.ts"
import { formatUnknownAgentMessage } from "../registry-error.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import { getAgentRuntimeConfig } from "../runtime/nitro-runtime-config.ts"

import type { EventHandler, H3Event } from "h3"
import type { NitroRuntimeConfig } from "nitro/types"
import type {
  AgentHandlerOptions,
  AgentInput,
  AgentRegistryHandlerOptions,
  AgentRequestBody,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeHooks,
} from "../types.ts"
import type { StateAdapter } from "chat"

export interface NitroAgentRuntimeConfig extends NitroRuntimeConfig, AgentRuntimeConfig {}

export interface NitroAgentRuntimeContext extends AgentRuntimeContext<NitroAgentRuntimeConfig> {
  event?: H3Event
  platform?: string
  request?: Request
  runtime: "nitro"
  runtimeConfig: NitroAgentRuntimeConfig
}

type AgentRegistryModule = { default?: AgentInput<NitroAgentRuntimeContext> } | AgentInput<NitroAgentRuntimeContext>
type AgentRegistry = Record<string, () => Promise<AgentRegistryModule>>

type RequestInitWithDuplex = RequestInit & { duplex?: "half" }
type RequestHeaders = NonNullable<RequestInit["headers"]>

interface RequestLike {
  body?: RequestInit["body"] | null
  headers?: RequestHeaders | Record<string, string | string[] | undefined>
  method?: string
  url?: string | URL
  [Symbol.asyncIterator]?: unknown
}

function normalizeHeaders(headers: RequestLike["headers"]): RequestHeaders | undefined {
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    return headers
  }

  const normalized = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) normalized.append(name, item)
    }
    else {
      normalized.set(name, value)
    }
  }
  return normalized
}

function getRequestURL(event: H3Event, req: RequestLike, headers: RequestHeaders | undefined): string | URL {
  if (event.url) {
    return event.url
  }
  if (req.url && String(req.url).startsWith("http")) {
    return req.url
  }

  const headerMap = new Headers(headers)
  const host = headerMap.get("host") || "localhost"
  const protocol = headerMap.get("x-forwarded-proto") || "http"
  return new URL(String(req.url || "/"), `${protocol}://${host}`)
}

function getRequestBody(method: string, req: RequestLike): RequestInit["body"] | undefined {
  if (method === "GET" || method === "HEAD") {
    return undefined
  }
  if (req.body != null) {
    return req.body
  }
  return typeof req[Symbol.asyncIterator] === "function" ? req as RequestInit["body"] : undefined
}

function toFetchRequest(event: H3Event): Request {
  const candidate = event.req as unknown
  if (candidate instanceof Request) {
    return candidate
  }

  const req = event.req as RequestLike
  const method = (req.method || "GET").toUpperCase()
  const headers = normalizeHeaders(req.headers)
  const init: RequestInitWithDuplex = { headers, method }
  const body = getRequestBody(method, req)
  if (body) {
    init.body = body
    init.duplex = "half"
  }
  return new Request(getRequestURL(event, req, headers), init)
}

function resolveRegistryModule(module: AgentRegistryModule): AgentInput<NitroAgentRuntimeContext> {
  return typeof module === "object" && module !== null && "default" in module
    ? module.default as AgentInput<NitroAgentRuntimeContext>
    : module as AgentInput<NitroAgentRuntimeContext>
}

function hasCustomRun(agent: AgentInput<NitroAgentRuntimeContext>): boolean {
  return typeof agent === "object" && agent !== null && "run" in agent && typeof agent.run === "function"
}

function createHookRunner<TContext extends AgentRuntimeContext>(hooks: AgentRuntimeHooks<TContext> | undefined) {
  return {
    async error(error: unknown, context: TContext) {
      await hooks?.error?.(error, context)
    },
    async request(context: TContext) {
      await hooks?.request?.(context)
    },
    async resolved(context: TContext & { agent: Awaited<ReturnType<typeof resolveAgent>> }) {
      await hooks?.resolved?.(context)
    },
  }
}

function isStreamResult(value: unknown): value is { toUIMessageStreamResponse?: () => Response, toTextStreamResponse?: () => Response } {
  return typeof value === "object"
    && value !== null
    && (typeof (value as { toUIMessageStreamResponse?: unknown }).toUIMessageStreamResponse === "function"
      || typeof (value as { toTextStreamResponse?: unknown }).toTextStreamResponse === "function")
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

function toEventStreamResponse(stream: AsyncIterable<unknown>): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        }
        controller.close()
      }
      catch (error) {
        controller.error(error)
      }
    },
  }), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  })
}

function toJsonSafeResult(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    raw: result.raw,
    text: result.text,
    usage: result.usage,
    warnings: result.warnings,
  }
}

function toResponse(value: unknown, stream: boolean): unknown {
  if (value instanceof Response) {
    return value
  }

  if (stream && isStreamResult(value)) {
    if (value.toUIMessageStreamResponse) {
      return value.toUIMessageStreamResponse()
    }
    return value.toTextStreamResponse?.()
  }
  if (stream && isAsyncIterable(value)) {
    return toEventStreamResponse(value)
  }

  return toJsonSafeResult(value)
}

function createRuntimeContext(event: H3Event): NitroAgentRuntimeContext {
  const runtimeConfig = getAgentRuntimeConfig(event) as NitroAgentRuntimeConfig
  return createAgentRuntimeContext({
    event,
    request: toFetchRequest(event),
    runtime: "nitro",
    runtimeConfig,
    waitUntil: task => event.waitUntil(task),
  }) as NitroAgentRuntimeContext
}

function getAgentCapabilities(agent: AgentInput<NitroAgentRuntimeContext>) {
  return (agent as { __vitehubAgentCapabilityOptions?: { capabilities?: unknown[] } }).__vitehubAgentCapabilityOptions?.capabilities
    || (agent as { __vitehubWorkspaceAgentOptions?: { capabilities?: unknown[] } }).__vitehubWorkspaceAgentOptions?.capabilities
    || []
}

function getAgentWorkspaceName(agent: AgentInput<NitroAgentRuntimeContext>): string | undefined {
  const defaults = (agent as { __vitehubWorkspaceAgentDefaults?: { workspace?: string, name?: string } }).__vitehubWorkspaceAgentDefaults
  const options = (agent as { __vitehubWorkspaceAgentOptions?: { workspace?: { name?: string } | string } }).__vitehubWorkspaceAgentOptions
  const optionWorkspace = options?.workspace
  const definitionWorkspace = (agent as { workspace?: { name?: string } | string }).workspace

  if (defaults?.workspace) return defaults.workspace
  if (typeof optionWorkspace === "string") return optionWorkspace
  if (typeof optionWorkspace === "object" && optionWorkspace?.name) return optionWorkspace.name
  if (typeof definitionWorkspace === "string") return definitionWorkspace
  if (typeof definitionWorkspace === "object" && definitionWorkspace?.name) return definitionWorkspace.name
}

async function createChatState(agent: AgentInput<NitroAgentRuntimeContext>, history: unknown): Promise<StateAdapter> {
  if (!history) return createMemoryChatStateAdapter()
  const workspaceName = getAgentWorkspaceName(agent)
  if (!workspaceName) {
    throw createError({
      statusCode: 500,
      statusMessage: "chat({ history }) requires an agent workspace.",
    })
  }
  const { useWorkspace } = await import("@vitehub/workspace")
  return createWorkspaceChatStateAdapter(useWorkspace(workspaceName, { allowWrite: true }))
}

type WebhookHandler = (request: Request, options?: { waitUntil?: (promise: Promise<unknown>) => void }) => unknown

function getChatWebhook(bot: { webhooks?: Record<string, WebhookHandler | undefined> }, platform: string): WebhookHandler | undefined {
  return bot.webhooks?.[platform]
}

async function readAgentBody(request: Request): Promise<AgentRequestBody> {
  const body = await request.clone().json().catch(() => undefined)
  return typeof body === "object" && body !== null ? body as AgentRequestBody : {}
}

export function defineAgentHandler(
  agent: AgentInput<NitroAgentRuntimeContext>,
  options: AgentHandlerOptions<NitroAgentRuntimeContext> = {},
): EventHandler {
  const hooks = createHookRunner(options.lifecycleHooks)

  return defineEventHandler(async (event) => {
    const context = createRuntimeContext(event)
    try {
      await hooks.request(context)

      const body = await readAgentBody(context.request!)
      const stream = body.stream !== false
      if (options.lifecycleHooks?.resolved && !hasCustomRun(agent)) {
        const resolved = await resolveAgent(agent, context)
        await hooks.resolved({ ...context, agent: resolved })
      }
      const result = stream
        ? await streamAgent(agent, context, body)
        : await runAgent(agent, context, body)

      return toResponse(result, stream)
    }
    catch (error) {
      await hooks.error(error, context).catch(() => undefined)
      throw error
    }
  })
}

export function defineAgentRegistryHandler(
  agents: AgentRegistry,
  options: AgentRegistryHandlerOptions<NitroAgentRuntimeContext> = {},
): EventHandler {
  const agentParam = options.agentParam || "agent"

  return defineEventHandler(async (event) => {
    const agentName = getRouterParam(event, agentParam)
    if (!agentName) {
      throw createError({
        statusCode: 400,
        statusMessage: `Missing agent route param: ${agentParam}`,
      })
    }

    const loader = agents[agentName]
    if (!loader) {
      throw createError({
        statusCode: 404,
        statusMessage: formatUnknownAgentMessage(agentName, Object.keys(agents).sort()),
      })
    }

    const agent = resolveRegistryModule(await loader())
    return await defineAgentHandler(agent, options)(event)
  })
}

export function defineAgentChatRegistryHandler(
  agents: AgentRegistry,
  options: AgentRegistryHandlerOptions<NitroAgentRuntimeContext> & { platformParam?: string } = {},
): EventHandler {
  const agentParam = options.agentParam || "agent"
  const platformParam = options.platformParam || "platform"

  return defineEventHandler(async (event) => {
    const agentName = getRouterParam(event, agentParam)
    const platform = getRouterParam(event, platformParam)
    if (!agentName) {
      throw createError({ statusCode: 400, statusMessage: `Missing agent route param: ${agentParam}` })
    }
    if (!platform) {
      throw createError({ statusCode: 400, statusMessage: `Missing chat platform route param: ${platformParam}` })
    }
    const loader = agents[agentName]
    if (!loader) {
      throw createError({
        statusCode: 404,
        statusMessage: formatUnknownAgentMessage(agentName, Object.keys(agents).sort()),
      })
    }
    const agent = resolveRegistryModule(await loader())
    const capability = getAgentCapabilities(agent).find(isChatCapability)
    if (!capability) {
      throw createError({ statusCode: 404, statusMessage: `Agent "${agentName}" does not define chat().` })
    }
    const context = { ...createRuntimeContext(event), platform } as NitroAgentRuntimeContext
    const state = await createChatState(agent, capability.options.history)
    const bot = await createChatBot(agent as never, capability.options as never, context as never, state, agentName)
    const webhook = getChatWebhook(bot, platform)
    if (!webhook) {
      throw createError({ statusCode: 404, statusMessage: `Unknown chat platform: ${platform}` })
    }
    return await webhook(context.request!, { waitUntil: task => event.waitUntil(task) })
  })
}

export const defineAgentChatWebhookHandler: typeof defineAgentChatRegistryHandler = defineAgentChatRegistryHandler
