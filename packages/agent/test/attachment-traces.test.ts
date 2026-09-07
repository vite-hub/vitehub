import { expect, it, vi } from "vitest"
import { createMessage, defineAgent, runAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

it("retains image references without callbacks, credentials, or bytes in invocation input", async () => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore(), metadataContent: ["input.messages"] })
  const agent = defineAgent({ invocations, driver: { run: () => "done" } })
  const pending: Promise<unknown>[] = []
  await runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil: task => { pending.push(task) } }, {
    messages: [createMessage({ role: "user", parts: [
      { type: "image", id: "image", mediaType: "image/png", url: "/files/image", fetchData: () => new Uint8Array([1, 2]), fetchMetadata: { token: "secret" } },
      { type: "image", mediaType: "image/png", data: "private-base64", url: "https://example.test/image?token=secret" },
    ] })],
  })
  await Promise.allSettled(pending)
  const page = await invocations.list()
  const record = await invocations.get(page.invocations[0]!.id)
  const input = record!.observations.find(event => event.name === "agent.invocation.start")!.attributes!["input.messages"]
  expect(input).toEqual([expect.objectContaining({ parts: [
    expect.objectContaining({ id: "image", type: "image", url: "/files/image" }),
    expect.objectContaining({ type: "image", mediaType: "image/png" }),
  ] })])
  expect(JSON.stringify(input)).not.toMatch(/fetchData|fetchMetadata|private-base64|secret/)
})
