import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import { apiKey } from "../src/api-key.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore, fakeProvider } from "./helpers.ts"
import { defineConnection } from "../src/definition.ts"

it("preserves a foreign ConnectionError from API-key verify", async () => {
  const provider = fakeProvider()
  const definition = defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], verify: async () => {
    throw runInNewContext(`Object.assign(new Error("denied"), { name: "ViteHubError", code: "CONNECTION_DENIED", details: { connection: "executor" } })`)
  } }) })
  const runtime = createConnectionsRuntime({ definitions: { executor: definition }, fetch: provider.fetch, store: createStore() })
  const error: unknown = await runtime.setKey({ name: "executor", key: "key" }).catch(cause => cause)
  expect(error).toMatchObject({ code: "CONNECTION_DENIED", reason: "denied", details: { connection: "executor" } })
})
