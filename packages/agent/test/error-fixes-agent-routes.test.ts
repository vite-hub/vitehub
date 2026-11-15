import { expect, it } from "vitest"

import { agentDiagnostics, isAgentTypeDiagnostic } from "../src/agent-diagnostics.ts"
import { agentHostRoutes } from "../src/host-routes-vite.ts"
import { processAgentHost } from "../src/process-host-vite.ts"
import { createAgentConsoleDelivery } from "../src/server/console-delivery.ts"
import { agentTriggerTask } from "../src/trigger-runtime.ts"

const codes = [
  "AGENT_CHANNEL_TASK_HANDLED",
  "AGENT_CHAT_RECOVERY_INDEX_CONFLICT",
  "AGENT_CONSOLE_DELIVERY_INCOMPLETE",
  "AGENT_CONSOLE_DELIVERY_URL_INVALID",
  "AGENT_DISPATCH_DRY_RUN_WITH_QUEUE",
  "AGENT_DISPATCH_ITEM_KEY_MISSING",
  "AGENT_DISPATCH_ITEM_ORDER_INVALID",
  "AGENT_DISPATCH_ITEM_REJECTED",
  "AGENT_DISPATCH_ITEMS_INVALID",
  "AGENT_DISPATCH_QUEUE_OWNERSHIP_INVALID",
  "AGENT_HOST_ROUTE_DUPLICATE",
  "AGENT_HOST_ROUTE_EXPORT_NAME_INVALID",
  "AGENT_HOST_ROUTE_PATH_INVALID",
  "AGENT_PROCESS_HOST_DRAIN_ROUTE_INVALID",
  "AGENT_PROCESS_HOST_EXPORT_NAME_INVALID",
  "AGENT_PROCESS_HOST_ROUTE_DUPLICATE",
  "AGENT_QUEUED_INPUT_NOT_JSON",
  "AGENT_QUEUED_TASK_AGENT_CHANGED",
  "AGENT_TASK_AGENT_NAME_MISSING",
  "AGENT_TRIGGER_PREPARE_INVALID",
  "AGENT_TRIGGER_SERIALIZE_CONFLICT",
  "AGENT_TRIGGER_SERIALIZE_INVALID",
  "AGENT_TRIGGER_TASK_INVALID",
  "AGENT_TRIGGER_TASK_UNKNOWN",
  "AGENT_TRIGGER_TASKS_INVALID",
  "AGENT_WEBHOOK_FENCE_UNAVAILABLE",
  "AGENT_WEBHOOK_HANDLED_RETRY",
  "AGENT_WEBHOOK_REHYDRATION_CHANGED",
  "AGENT_WEBHOOK_STATE_SCOPE_INVALID",
] as const

const params = { channelId: "c", deliveryId: "d", expected: "a", id: "r", key: "k", kind: "task", phase: "delivery", problem: "must be an object.", reason: undefined, resolved: "b", route: "/api/health", status: 503, step: "acquire", task: "t", triggerId: "c.t" } as const

it("gives each Channel route, trigger, and host route code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: each code reads only the params it declares from this shared object.
    const error = (agentDiagnostics[code] as (input: typeof params) => Error & { fix?: string, docs?: string })(params)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports Console delivery without a token with a code and a fix", () => {
  expect(() => createAgentConsoleDelivery({ url: "https://console.example" })).toThrow(expect.objectContaining({
    code: "AGENT_CONSOLE_DELIVERY_INCOMPLETE",
    message: "Console delivery requires both url and token.",
    fix: expect.stringContaining("createAgentConsoleDelivery({ url, token })"),
  }))
})

it("reports an undeclared trigger task with a code and a fix", () => {
  const error = (() => {
    try { agentTriggerTask({ id: "github.review", tasks: {} }, "fix") }
    catch (caught) { return caught }
  })()
  expect(error).toMatchObject({
    code: "AGENT_TRIGGER_TASK_UNKNOWN",
    message: "[vitehub] Task \"fix\" is not declared by trigger \"github.review\".",
    fix: expect.stringContaining("`tasks`"),
  })
  // A trigger error keeps the input-error status that the TypeError had.
  expect(isAgentTypeDiagnostic(error)).toBe(true)
})

it("reports a relative processAgentHost() drain route with a code and a fix", async () => {
  const plugin = processAgentHost({ entry: "server/host.ts", drainRoute: "api/drain" })
  // SAFETY: the config hook is a plain async function in this plugin.
  await expect((plugin.config as (config: object) => Promise<unknown>)({ root: "/tmp/vitehub-process-host-check" })).rejects.toMatchObject({
    code: "AGENT_PROCESS_HOST_DRAIN_ROUTE_INVALID",
    fix: expect.stringContaining("processAgentHost({ drainRoute })"),
  })
})

it("reports an agentHostRoutes() export that is not an identifier with a code and a fix", async () => {
  const plugin = agentHostRoutes({ entry: "server/host.ts", health: "not-valid" })
  // SAFETY: the config hook is a plain async function in this plugin.
  await expect((plugin.config as (config: object) => Promise<unknown>)({ root: "/tmp/vitehub-host-routes-check" })).rejects.toMatchObject({
    code: "AGENT_HOST_ROUTE_EXPORT_NAME_INVALID",
    fix: expect.stringContaining("agentHostRoutes("),
  })
})
