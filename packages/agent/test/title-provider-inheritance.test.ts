import { expect, it, vi } from "vitest"
import { codexDriver, defineAgent, runAgent } from "../src/index.ts"
import { title } from "../src/capabilities/title.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"

const { createProviderAgentAdapter } = vi.hoisted(() => ({
  createProviderAgentAdapter: vi.fn((driver: { model?: string }) => ({ generate: vi.fn(async () => ({
    text: "Inherited title",
    usageRecord: { model: driver.model, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  })) })),
}))
vi.mock("../src/provider-agent.ts", () => ({ createProviderAgentAdapter }))

it("uses the enclosing provider configuration when generating a title", async () => {
  const env = { TITLE_TEST_VALUE: "inherited" }
  const invocations = defineAgentInvocations({ metadataContent: ["vitehub.session.title"], store: createMemoryAgentInvocationStore() })
  const agent = defineAgent({
    capabilities: [title({ model: "title-model" })],
    driver: codexDriver({ model: "main-model", env }),
    invocations,
    runtime: false,
  })
  await runAgent(agent, { memo: vi.fn(), run: { runId: "inherit-provider" }, runtime: "unknown", waitUntil: vi.fn() }, { prompt: "Explain agent titles." })
  expect(createProviderAgentAdapter).toHaveBeenCalledWith(expect.objectContaining({
    kind: "provider", provider: "codex", model: "title-model", env,
  }))
  const invocation = (await invocations.getByRunId("inherit-provider"))!
  expect(invocation.observations.find(entry => entry.name === "agent.invocation.finish")?.attributes?.["usage.record"]).toMatchObject({
    calls: [
      { model: "main-model", usage: { totalTokens: 5 } },
      { model: "title-model", usage: { totalTokens: 5 } },
    ],
    usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
  })
  expect(invocation.observations).toContainEqual(expect.objectContaining({
    name: "agent.title.recorded",
    attributes: expect.objectContaining({ "vitehub.session.title": "Inherited title" }),
  }))
})

it("redacts provider-generated credentials before persisting title metadata", async () => {
  createProviderAgentAdapter.mockImplementationOnce(() => ({
    generate: vi.fn(async () => ({ text: "Main answer" })),
  })).mockImplementationOnce(() => ({
    generate: vi.fn(async () => ({ text: "password=hunter2" })),
  }))
  const invocations = defineAgentInvocations({ metadataContent: ["vitehub.session.title"], store: createMemoryAgentInvocationStore() })
  const agent = defineAgent({
    capabilities: [title({ model: "title-model" })],
    driver: codexDriver({ model: "main-model" }),
    invocations,
    runtime: false,
  })
  await runAgent(agent, { memo: vi.fn(), run: { runId: "secret-title" }, runtime: "unknown", waitUntil: vi.fn() }, { prompt: "Explain agent titles." })
  const invocation = await invocations.getByRunId("secret-title")
  expect(invocation?.observations).toContainEqual(expect.objectContaining({
    name: "agent.title.recorded",
    attributes: expect.objectContaining({ "vitehub.session.title": "password=[REDACTED]" }),
  }))
  expect(JSON.stringify(invocation)).not.toContain("hunter2")
})
