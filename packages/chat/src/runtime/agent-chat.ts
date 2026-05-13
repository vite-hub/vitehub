import { createWorkflow } from "@vitehub/workflow"
import { getWorkflowRuntimeEvent } from "@vitehub/workflow/runtime/state"
import { useRuntimeConfig } from "nitro/runtime-config"

import { executeChatAgentResponse } from "../agent-handoff.ts"
import { defineChat, resolveChat } from "../index.ts"

import type { AgentDefinition } from "@vitehub/agent"
import type { WorkflowExecutionContext } from "@vitehub/workflow"
import type { ChatAgentWorkflowPayload } from "../agent-handoff.ts"
import type { ChatDefinition, ChatRuntimeConfig, ChatWorkflowHandle, DefineChatOptions, ResolvedChatRuntimeContext } from "../types.ts"

const workflowCache = new WeakMap<AgentDefinition<any>, Map<string, ChatWorkflowHandle<ChatAgentWorkflowPayload>>>()

function createMemo() {
  const cache = new Map<string, unknown>()
  return async <T>(key: string, factory: () => T | Promise<T>) => {
    if (cache.has(key)) {
      return cache.get(key) as T
    }

    const value = await factory()
    cache.set(key, value)
    return value
  }
}

function getCloudflareEnvFromEvent(event: unknown) {
  const target = event as {
    env?: Record<string, unknown>
    context?: {
      cloudflare?: { env?: Record<string, unknown> }
      _platform?: { cloudflare?: { env?: Record<string, unknown> } }
    }
    req?: { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }
  } | undefined

  return (
    target?.env ||
    target?.context?.cloudflare?.env ||
    target?.context?._platform?.cloudflare?.env ||
    target?.req?.runtime?.cloudflare?.env ||
    (globalThis as { __env__?: Record<string, unknown> }).__env__
  )
}

function runtimeContext<TRuntimeConfig extends ChatRuntimeConfig>(options: Pick<ChatAgentWorkflowPayload, "cloudflare" | "dev"> = {}): ResolvedChatRuntimeContext<TRuntimeConfig> {
  const cloudflare = options.cloudflare
  const env = cloudflare?.env || getCloudflareEnvFromEvent(getWorkflowRuntimeEvent()) || {}
  const event = { env }
  const runtimeConfig = (useRuntimeConfig as unknown as (event?: unknown) => Record<string, unknown>)(event)
  const applyEnvRuntimeConfig = (globalThis as {
    __vitehubApplyEnvRuntimeConfig?: (runtimeConfig: Record<string, unknown>, event?: unknown) => Record<string, unknown>
  }).__vitehubApplyEnvRuntimeConfig

  return {
    cloudflare: cloudflare || { env },
    dev: options.dev,
    memo: createMemo(),
    runtime: "nitro",
    runtimeConfig: (applyEnvRuntimeConfig?.(runtimeConfig, event) || runtimeConfig) as TRuntimeConfig,
    waitUntil: () => {},
  } as ResolvedChatRuntimeContext<TRuntimeConfig>
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function shouldRunWorkflowInlineInDev() {
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
  return env?.DEV === true
}

function createChatAgentWorkflow<TRuntimeConfig extends ChatRuntimeConfig>(
  agent: AgentDefinition<TRuntimeConfig>,
  name: string,
): ChatWorkflowHandle<ChatAgentWorkflowPayload> {
  const cached = workflowCache.get(agent)?.get(name)
  if (cached) {
    return cached
  }

  const workflowName = agent.runtime?.kind === "workflow" && agent.runtime.name
    ? agent.runtime.name
    : `agent:${name}`

  let handle!: ChatWorkflowHandle<ChatAgentWorkflowPayload>
  const handler = async ({ payload, step }: WorkflowExecutionContext<ChatAgentWorkflowPayload>) => {
    if (!payload.threadId) {
      throw new Error("Missing chat thread id for workflow reply.")
    }

    const context = runtimeContext<TRuntimeConfig>(payload)
    const bot = await resolveChat(createChatFromAgent(agent, name), context, { inferredName: name })
    const thread = bot.thread(payload.threadId)
    const baseArgs = {
      bot,
      channel: { id: payload.channelId },
      context: undefined,
      history: payload.history,
      message: payload.message,
      run: payload.run,
      runtimeConfig: context.runtimeConfig,
      thread,
      workflow: handle,
    }
    const runAgent = async () => await executeChatAgentResponse(context, {
      definition: agent as never,
      hooks: agent.hooks as never,
      name: payload.agentName,
    }, baseArgs as never, payload.input)

    try {
      await (step?.do
        ? step.do("run chat agent", {}, runAgent)
        : runAgent())
    }
    catch (error) {
      await thread.post(`ViteHub chat response failed: ${errorMessage(error)}`)
      throw error
    }
  }
  handle = shouldRunWorkflowInlineInDev()
    ? {
        name: workflowName,
        defer: async (payload?: ChatAgentWorkflowPayload, options = {}) => {
          const id = options.id || `inline-${Date.now()}`
          await handler({ id, name: workflowName, payload: payload as ChatAgentWorkflowPayload, provider: "vercel" })
          return { id, payload, provider: "vercel", status: "completed" as const }
        },
        getRun: async (id: string) => ({ id, provider: "vercel", status: "completed" as const }),
        run: async (payload?: ChatAgentWorkflowPayload, options = {}) => {
          const id = options.id || `inline-${Date.now()}`
          await handler({ id, name: workflowName, payload: payload as ChatAgentWorkflowPayload, provider: "vercel" })
          return { id, payload, provider: "vercel", status: "completed" as const }
        },
      } satisfies ChatWorkflowHandle<ChatAgentWorkflowPayload>
    : createWorkflow<ChatAgentWorkflowPayload>(workflowName, handler)
  const agentWorkflows = workflowCache.get(agent) || new Map()
  agentWorkflows.set(name, handle)
  workflowCache.set(agent, agentWorkflows)
  return handle
}

export function createChatFromAgent<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
>(
  agent: AgentDefinition<TRuntimeConfig>,
  name: string,
): ChatDefinition<TRuntimeConfig> {
  if (!agent.chat) {
    throw new Error(`[vitehub:chat] Agent "${name}" does not define chat config.`)
  }

  const {
    event,
    history,
    hooks,
    ...chat
  } = agent.chat
  const workflow = agent.runtime?.kind === "workflow"
    ? createChatAgentWorkflow(agent, name)
    : undefined

  return defineChat({
    ...(chat as Omit<DefineChatOptions<TRuntimeConfig, TWorkflow>, "agent">),
    hooks: hooks as DefineChatOptions<TRuntimeConfig, TWorkflow>["hooks"],
    workflow: workflow as TWorkflow,
    agent: {
      definition: agent as never,
      event,
      execution: workflow ? "workflow" : "inline",
      history,
      hooks: agent.hooks as never,
      name,
    },
  })
}
