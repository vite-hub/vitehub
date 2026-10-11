import { afterEach, expect, it, vi } from "vitest"

vi.mock("#vitehub/connections/registry", () => ({ default: {}, database: undefined }))

import { setConnectionsRuntime, useConnection } from "../src/runtime/state.ts"
import { defineConnection } from "../src/definition.ts"
import { connect, createTestRuntime, testProvider } from "./helpers.ts"

const definition = defineConnection({ api: { mail: ["labels.*"] }, provider: testProvider(), scopes: ["mail.modify"] })

declare global {
  interface ViteHubConnectionDefinitionModules {
    mail: { default: typeof definition }
  }
}

afterEach(() => setConnectionsRuntime(undefined))

it("serializes nested API proxies without dispatching provider calls", async () => {
  const test = createTestRuntime()
  await connect(test)
  setConnectionsRuntime({ definitions: { mail: async () => ({ default: definition }) }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
  const connection = useConnection("mail")
  const before = test.provider.calls.length
  expect(JSON.stringify({ api: connection.mail, labels: connection.mail.labels })).toBe("{}")
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(test.provider.calls).toHaveLength(before)
})

it("trims surrounding whitespace from connection names", async () => {
  const test = createTestRuntime()
  await connect(test)
  setConnectionsRuntime({ definitions: { mail: async () => ({ default: definition }) }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
  const connection = useConnection(" mail " as string) as unknown as { mail: { labels: { list: (input: { userId: string }) => Promise<unknown> } } }
  await expect(connection.mail.labels.list({ userId: "me" })).resolves.toEqual({ labels: [{ id: "INBOX" }] })
})
