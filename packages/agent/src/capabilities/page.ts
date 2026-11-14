import { defineCapability } from "../capability-runtime.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { pageContextKey, pageHeader, pageRealtimeDefinition } from "../internal/page.ts"
import { defineInternalTool, primitiveHandle } from "./internal.ts"
import { pageTools } from "./page-tools.ts"

import type { AgentCapabilityContext, AgentCapabilityDefinition, AgentToolSet } from "../types.ts"
import type { PageToolDefinition } from "./page-tools.ts"

export interface PageCapabilityOptions {
  /** How long `page_snapshot` and `page_query` wait for the page to answer, in milliseconds. Default 30 seconds. */
  timeout?: number
  /**
   * How long `page_act` waits for the page, in milliseconds. Default 330 seconds: a step that needs a person waits up to
   * 5 minutes on the page bridge's `allow`.
   */
  actTimeout?: number
}

/** What a page tool returns when the page could not answer, in the shape of a failed ui-sdk step. */
export interface PageCallFailure {
  ok: false
  code: string
  error: string
}

const pageIdPattern = /^[\w-]{8,128}$/

function readPageId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? value.id : undefined
  return typeof id === "string" && pageIdPattern.test(id) ? id : undefined
}

/**
 * The page of this run: `context.page` on the Invocation input, else the `x-vitehub-page` header of the request that
 * started it, which `connectPage()` and `useChat(agent, { page })` send.
 */
function resolvePageId(context: AgentCapabilityContext): string | undefined {
  const fromInput = readPageId(context.invocation?.input.get().context?.[pageContextKey])
  if (fromInput) return fromInput
  return readPageId(context.runtimeContext?.request?.headers.get(pageHeader) ?? undefined)
}

/** `agentRealtime` from `@vite-hub/realtime/agent`, which ViteHub passes as `capabilities.realtime`. */
interface PageRealtime {
  available: () => boolean
  request: (definition: string, room: string, body: unknown, options: { signal?: AbortSignal, timeout?: number }) => Promise<
    [error: { code: string, why: string }, data: undefined] | [error: undefined, data: unknown]
  >
}

function isPageRealtime(value: unknown): value is PageRealtime {
  return typeof value === "object" && value !== null
    && "available" in value && typeof value.available === "function"
    && "request" in value && typeof value.request === "function"
}

function requirePageRealtime(context: AgentCapabilityContext): PageRealtime {
  const handle = primitiveHandle(context, "realtime")
  if (!isPageRealtime(handle) || !handle.available()) throw agentDiagnostics.AGENT_R1045()
  return handle
}

async function callPage(realtime: PageRealtime, id: string, tool: PageToolDefinition, input: unknown, timeout: number, signal: AbortSignal | undefined): Promise<unknown> {
  const [error, answer] = await realtime.request(pageRealtimeDefinition, id, { method: tool.method, input: input ?? {} }, {
    timeout,
    ...(signal ? { signal } : {}),
  })
  if (!error) return answer
  const failure: PageCallFailure = { ok: false, code: error.code, error: error.why }
  return failure
}

/**
 * Lets the Agent work the person's page through ui-sdk's agent bridge: `page_snapshot` reads its components,
 * `page_query` finds components and list items, and `page_act` runs steps through each component's api. Each call goes
 * over Realtime to the page that started the run, which joined with `connectPage()` or `useChat(agent, { page })`.
 * A run without a page gets no page tools. A page that closed, or did not answer, gives the model `{ ok: false, code,
 * error }`, so it can tell the person.
 */
export function page(options: PageCapabilityOptions = {}): AgentCapabilityDefinition {
  const timeout = options.timeout ?? 30_000
  const actTimeout = options.actTimeout ?? 330_000
  return defineCapability({
    id: "page",
    metadata: { realtime: pageRealtimeDefinition, tools: pageTools.map(tool => tool.name) },
    requires: [{ primitive: "realtime" }],
    tools(context): AgentToolSet | undefined {
      const id = resolvePageId(context)
      if (!id) return undefined
      const realtime = requirePageRealtime(context)
      return Object.fromEntries(pageTools.map(tool => [tool.name, defineInternalTool({
        name: tool.name,
        description: tool.description,
        icon: tool.icon,
        inputSchema: tool.inputSchema,
        title: tool.title,
        execute: (input, toolContext) => callPage(realtime, id, tool, input, tool.method === "act" ? actTimeout : timeout, toolContext?.abortSignal ?? context.abortSignal),
      })]))
    },
  })
}
