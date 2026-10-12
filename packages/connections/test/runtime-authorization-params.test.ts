import { expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"

import type { ConnectionStore } from "../src/store.ts"

it("ignores inherited authorization params", async () => {
  const proto = { authorizationParams: { injected: "yes" } }
  const provider = Object.assign(Object.create(proto), {
    account: () => undefined,
    apis: {},
    authorizationEndpoint: "https://auth.example.com/authorize",
    clientId: "client-id",
    id: "example",
    tokenEndpoint: "https://auth.example.com/token",
  })
  const definition = defineConnection({ provider, scopes: [] })
  const authorizations = { put: async () => undefined }
  const store = { authorizations } as unknown as ConnectionStore
  const runtime = createConnectionsRuntime({ definitions: { mail: definition }, fetch, store })
  const result = await runtime.authorize({ name: "mail", redirectUri: "http://127.0.0.1/callback" })
  expect(new URL(result.url).searchParams.has("injected")).toBe(false)
})
