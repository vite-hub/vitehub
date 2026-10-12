import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { runAgentWorkflowDefinition } from "../src/runtime/workflow.ts"

const context = {
  id: "date-result",
  name: "date-result",
  payload: {},
  provider: "vercel",
} as const

const dates = [
  { realm: "local", date: new Date(0) },
  { realm: "foreign", date: runInNewContext("new Date(0)") },
  { realm: "foreign invalid", date: runInNewContext("new Date(NaN)") },
]

const proxyDate = new Proxy(new Date(0), {})

describe("Agent workflow Date result boundaries", () => {
  it.each(dates)("rejects a $realm Date when the envelope has no portable fields", async ({ date }) => {
    await expect(runAgentWorkflowDefinition({} as never, context, async () => ({
      finishReason: undefined,
      raw: date,
      text: undefined,
      usage: undefined,
      usageRecord: undefined,
      warnings: undefined,
    }))).rejects.toMatchObject({
      code: "AGENT_R0744",
      isRetryable: false,
      message: "Agent Workflow results must contain only JSON-compatible values.",
    })
  })

  it.each(dates)("omits a $realm Date from provider raw data", async ({ date }) => {
    await expect(runAgentWorkflowDefinition({} as never, context, async () => ({
      content: "portable content",
      raw: { createdAt: date },
    }))).resolves.toEqual({ content: "portable content" })
  })

  it("rejects a proxy-wrapped Date when the envelope has no portable fields", async () => {
    await expect(runAgentWorkflowDefinition({} as never, context, async () => ({
      finishReason: undefined,
      raw: proxyDate,
      text: undefined,
      usage: undefined,
      usageRecord: undefined,
      warnings: undefined,
    }))).rejects.toMatchObject({
      code: "AGENT_R0744",
      isRetryable: false,
      message: "Agent Workflow results must contain only JSON-compatible values.",
    })
  })

  it("omits a proxy-wrapped Date from provider raw data", async () => {
    await expect(runAgentWorkflowDefinition({} as never, context, async () => ({
      content: "portable content",
      raw: { createdAt: proxyDate },
    }))).resolves.toEqual({ content: "portable content" })
  })
})
