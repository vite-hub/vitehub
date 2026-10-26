import { afterEach, expect, it, vi } from "vitest"

vi.mock("#vitehub/connections/registry", () => ({ default: {}, activityRetention: undefined, database: undefined }))

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

it("resolves nested API methods lazily and dispatches their input", async () => {
  const test = createTestRuntime()
  await connect(test)
  const list = useConnection("mail").mail.labels.list
  const before = test.provider.calls.length
  setConnectionsRuntime({ definitions: { mail: async () => ({ default: definition }) }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
  expect(await list({ userId: "a/b" })).toEqual([undefined, { labels: [{ id: "INBOX" }] }])
  expect(test.provider.calls.slice(before)).toMatchObject([
    { method: "GET", url: "https://mail.example.com/mail/v1/users/a%2Fb/labels" },
  ])
})

it("keeps public fetch separate from nested API methods", async () => {
  const test = createTestRuntime()
  await connect(test)
  const fetch = useConnection("mail").fetch
  setConnectionsRuntime({ definitions: { mail: async () => ({ default: definition }) }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
  const [error, response] = await fetch(new URL("https://mail.example.com/mail/v1/users/me/labels"), { headers: { Accept: "application/json" } })
  expect(error).toBeUndefined()
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ labels: [{ id: "INBOX" }] })
  expect(test.provider.calls.at(-1)?.headers.get("accept")).toBe("application/json")
})

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

it("rejects surrounding whitespace in Connection names", async () => {
  const test = createTestRuntime()
  await connect(test)
  setConnectionsRuntime({ definitions: { mail: async () => ({ default: definition }) }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
  expect(() => useConnection(" mail " as string)).toThrow("Connection name")
  const connection = useConnection("mail")
  expect(connection.name).toBe("mail")
})

it("resolves the Connection status and never rejects", async () => {
  const test = createTestRuntime()
  setConnectionsRuntime({ definitions: { mail: async () => ({ default: definition }) }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
  await expect(useConnection("mail").status()).resolves.toBe("disconnected")
  await connect(test)
  await expect(useConnection("mail").status()).resolves.toBe("connected")
  // A store that cannot open and a Connection that does not exist both count as disconnected.
  setConnectionsRuntime({ definitions: { mail: async () => ({ default: definition }) }, store: () => Promise.reject(new Error("no store")) })
  await expect(useConnection("mail").status()).resolves.toBe("disconnected")
  await expect(useConnection("missing" as string).status()).resolves.toBe("disconnected")
})
