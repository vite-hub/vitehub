import { expect, it, vi } from "vitest"
import { codexDriver, defineAgent, runAgent } from "../src/index.ts"
import { title } from "../src/capabilities/title.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"

const { createProviderAgentAdapter } = vi.hoisted(() => ({
  createProviderAgentAdapter: vi.fn(() => ({ generate: vi.fn(async () => ({ text: "Inherited title" })) })),
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
  expect((await invocations.getByRunId("inherit-provider"))?.observations).toContainEqual(expect.objectContaining({
    name: "agent.title.recorded",
    attributes: expect.objectContaining({ "vitehub.session.title": "Inherited title" }),
  }))
})
