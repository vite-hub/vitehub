import { expect, it } from "vitest"
import { apiKey } from "../src/api-key.ts"
import { connectionsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore, fakeProvider } from "./helpers.ts"
import { defineConnection } from "../src/definition.ts"

function runtimeWithVerify(verify: () => Promise<never>) {
  const provider = fakeProvider()
  const definition = defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], verify }) })
  return createConnectionsRuntime({ definitions: { executor: definition }, fetch: provider.fetch, store: createStore() })
}

it("keeps a Connections error from API-key verify", async () => {
  const runtime = runtimeWithVerify(async () => {
    throw connectionsErrorDiagnostics.CONNECTIONS_UNAVAILABLE({ connection: "executor" })
  })
  const error: unknown = await runtime.setKey({ name: "executor", key: "key" }).catch(cause => cause)
  expect(error).toMatchObject({ code: "CONNECTIONS_UNAVAILABLE" })
})

it.each([
  ["a plain error", () => new Error("bad secret-key")],
  ["a ViteHubError shape from another package copy", () => Object.assign(new Error("bad secret-key"), { code: "CONNECTIONS_DENIED", name: "ViteHubError" })],
  ["a Connections error that contains the key", () => connectionsErrorDiagnostics.CONNECTIONS_UNAVAILABLE({ connection: "secret-key" })],
])("replaces %s with a provider failure that does not contain the key", async (_, create) => {
  const runtime = runtimeWithVerify(async () => {
    throw create()
  })
  const error: unknown = await runtime.setKey({ name: "executor", key: "secret-key" }).catch(cause => cause)
  expect(error).toMatchObject({ code: "CONNECTIONS_PROVIDER_FAILED", why: "Provider \"api-key\" could not verify the key." })
  expect(JSON.stringify(error)).not.toContain("secret-key")
  expect(String(error)).not.toContain("secret-key")
})
