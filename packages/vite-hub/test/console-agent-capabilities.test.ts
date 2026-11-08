import { defineAgent, type AgentRunContext } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { expect, it, vi } from "vitest"

import { installConsoleAgentDefinitions, installConsoleInvocations } from "../src/console/server.ts"
import agentInvocationsRoute from "../src/console/runtime/server/agent-invocations.post.ts"
import { allowed } from "./support/console-access.ts"
import { consoleEvent } from "./console-event.ts"

it.each(["object", "loader"] as const)("invokes an Agent with Console capabilities supplied in %s form", async (form) => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const root = `/console-agent-capabilities-${form}`
  const capabilities = { example: { value: "available" } }
  const load = vi.fn(async () => capabilities)
  const run = vi.fn((_context: AgentRunContext) => "done")
  const agent = defineAgent({ driver: { run }, invocations, name: "support", runtime: false })
  installConsoleInvocations(root, invocations)
  installConsoleAgentDefinitions([{ definition: agent, fallbackName: "support" }], {
    capabilities: form === "object" ? capabilities : load,
    invoke: true,
    projectRoot: root,
  })
  expect(load).not.toHaveBeenCalled()

  const result = await allowed(agentInvocationsRoute)(consoleEvent({
    body: { prompt: "Use the configured capabilities." },
    context: { params: { agent: "support" } },
    url: "http://localhost/api/_vitehub/console/agents/support/invocations",
  }))
  await vi.waitFor(async () => {
    await expect(invocations.get(result.id)).resolves.toMatchObject({ status: "completed" })
  })
  expect(run).toHaveBeenCalledOnce()
  expect(run.mock.calls[0]?.[0].capabilities.example).toBe(capabilities.example)
  expect(load).toHaveBeenCalledTimes(form === "loader" ? 1 : 0)
})
