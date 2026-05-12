import { getAgentFromRegistry, streamAgent } from "@vitehub/agent"
import { createWorkflow } from "@vitehub/workflow"
import { useRuntimeConfig } from "nitro/runtime-config"

import { defineChat, resolveChat } from "../index.ts"

import type { AgentDefinition, AgentRunInput, AgentRunMetadata } from "@vitehub/agent"
import type { WorkflowExecutionContext } from "@vitehub/workflow"
import type { ChatDefinition, ChatRuntimeConfig, ChatRuntimeContext, ChatWorkflowHandle, DefineChatOptions } from "../types.ts"

interface AgentChatWorkflowPayload {
  agentName: string
  input: AgentRunInput
  run: AgentRunMetadata
  threadId?: string
}

const workflowCache = new WeakMap<AgentDefinition<any>, Map<string, ChatWorkflowHandle<AgentChatWorkflowPayload>>>()

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

function runtimeContext<TRuntimeConfig extends ChatRuntimeConfig>(): ChatRuntimeContext<TRuntimeConfig> {
  const env = (globalThis as { __env__?: Record<string, unknown> }).__env__ || {}
  const event = { env }
  const runtimeConfig = (useRuntimeConfig as unknown as (event?: unknown) => Record<string, unknown>)(event)
  const applyEnvRuntimeConfig = (globalThis as {
    __vitehubApplyEnvRuntimeConfig?: (runtimeConfig: Record<string, unknown>, event?: unknown) => Record<string, unknown>
  }).__vitehubApplyEnvRuntimeConfig

  return {
    cloudflare: { env },
    memo: createMemo(),
    runtime: "nitro",
    runtimeConfig: (applyEnvRuntimeConfig?.(runtimeConfig, event) || runtimeConfig) as TRuntimeConfig,
    waitUntil: () => {},
  } as ChatRuntimeContext<TRuntimeConfig>
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createChatAgentWorkflow<TRuntimeConfig extends ChatRuntimeConfig>(
  agent: AgentDefinition<TRuntimeConfig>,
  name: string,
): ChatWorkflowHandle<AgentChatWorkflowPayload> {
  const cached = workflowCache.get(agent)?.get(name)
  if (cached) {
    return cached
  }

  const workflowName = agent.runtime?.kind === "workflow" && agent.runtime.name
    ? agent.runtime.name
    : `agent:${name}`

  const handle = createWorkflow<AgentChatWorkflowPayload>(workflowName, async ({ payload, step }: WorkflowExecutionContext<AgentChatWorkflowPayload>) => {
    if (!payload.threadId) {
      throw new Error("Missing chat thread id for workflow reply.")
    }

    const context = runtimeContext<TRuntimeConfig>()
    const bot = await resolveChat(createChatFromAgent(agent, name), context, { inferredName: name })
    const thread = bot.thread(payload.threadId)
    const agentContext = { ...context, run: payload.run } as never
    const runAgent = async () => {
      const definition = await getAgentFromRegistry(payload.agentName, agentContext as never)
      return await streamAgent(definition as never, agentContext as never, payload.input)
    }

    try {
      const result = step?.do
        ? await step.do("run chat agent", {}, runAgent)
        : await runAgent()

      await thread.post(result as never)
    }
    catch (error) {
      await thread.post(`ViteHub chat response failed: ${errorMessage(error)}`)
      throw error
    }
  })
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
      event,
      execution: workflow ? "workflow" : "inline",
      history,
      hooks: agent.hooks as never,
      name,
    },
  })
}
