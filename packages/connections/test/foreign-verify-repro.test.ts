import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import { apiKey } from "../src/api-key.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore, fakeProvider } from "./helpers.ts"
import { errorResponse } from "../src/internal/http-routes.ts"
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

it("sanitizes foreign verification messages and key-bearing details", async () => {
  const provider = fakeProvider()
  const key = "secret-key"
  const definition = defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], verify: async () => {
    throw runInNewContext(`Object.assign(new Error("bad ${key}"), { name: "ViteHubError", code: "CONNECTION_DENIED", message: "bad ${key}", details: { connection: "executor", leaked: "bad ${key}" } })`)
  } }) })
  const runtime = createConnectionsRuntime({ definitions: { executor: definition }, fetch: provider.fetch, store: createStore() })
  const error: unknown = await runtime.setKey({ name: "executor", key }).catch(cause => cause)
  expect(error).toMatchObject({ code: "CONNECTION_DENIED", reason: "denied" })
  expect(String(error)).not.toContain(key)
  expect(error).not.toHaveProperty("details.leaked")
})

it("falls back for foreign errors with malformed request IDs", async () => {
  const provider = fakeProvider()
  const definition = defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], verify: async () => {
    throw runInNewContext(`Object.assign(new Error("denied"), { name: "ViteHubError", code: "CONNECTION_DENIED", requestId: 42 })`)
  } }) })
  const runtime = createConnectionsRuntime({ definitions: { executor: definition }, fetch: provider.fetch, store: createStore() })
  await expect(runtime.setKey({ name: "executor", key: "key" })).rejects.toMatchObject({ code: "CONNECTION_PROVIDER" })
})

it.each(["secret-key", "request-secret-key-suffix", "safe-request"])("filters key-bearing request ID %s", async (requestId) => {
  const key = "secret-key"
  const provider = fakeProvider()
  const definition = defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], verify: async () => {
    throw runInNewContext(`Object.assign(new Error("denied"), { name: "ViteHubError", code: "CONNECTION_DENIED", requestId, details: { [key]: "hidden", connection: "executor" } })`, { requestId, key })
  } }) })
  const runtime = createConnectionsRuntime({ definitions: { executor: definition }, fetch: provider.fetch, store: createStore() })
  const error: unknown = await runtime.setKey({ name: "executor", key }).catch(cause => cause)
  expect(error).toMatchObject({ code: "CONNECTION_DENIED", requestId: requestId.includes(key) ? undefined : requestId })
  expect(String(error)).not.toContain(key)
  expect(JSON.stringify(error)).not.toContain(key)
  expect(await errorResponse(error).text()).not.toContain(key)
})

it.each([
  'message: "x".repeat(16_385)',
  'details: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), i]))',
  'details: { value: "x".repeat(16_385) }',
  'details: { value: Infinity }',
])("falls back safely for invalid foreign fields: %s", async (fields) => {
  const provider = fakeProvider()
  const definition = defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], verify: async () => {
    throw runInNewContext(`Object.assign(new Error("denied"), { name: "ViteHubError", code: "CONNECTION_DENIED", ${fields} })`)
  } }) })
  const runtime = createConnectionsRuntime({ definitions: { executor: definition }, fetch: provider.fetch, store: createStore() })
  await expect(runtime.setKey({ name: "executor", key: "secret-key" })).rejects.toMatchObject({ code: "CONNECTION_PROVIDER" })
})
