import { describe, expect, it } from "vitest"
import { agentEnvAccess } from "../../env/test/agent-access.ts"
import { SecretEnv } from "../../env/src/secret.ts"

import { apiKey } from "../src/api-key.ts"
import { defineConnection } from "../src/definition.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore } from "./helpers.ts"

import type { ConnectionStore } from "../src/store.ts"
import type { ConnectionApiKeyFallback, ConnectionDefinition } from "../src/types.ts"

const ENV_KEY = "sk_env_fallback_key_1"
const STORED_KEY = "sk_live_stored_key_1"
const URL_ITEMS = "https://api.example.com/items"

function harness(fallback: ConnectionApiKeyFallback, options: { access?: ConnectionDefinition["access"], store?: ConnectionStore | (() => ConnectionStore) } = {}) {
  const keys: Array<string | null> = []
  let fallbackCalls = 0
  const fetcher: typeof fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get("authorization"))
    return Response.json({ items: ["a"] })
  }
  const definition = defineConnection({
    provider: apiKey({
      origins: ["https://api.example.com"],
      fallback: () => {
        fallbackCalls += 1
        return fallback()
      },
    }),
    ...(options.access ? { access: options.access } : {}),
  })
  const store = options.store ?? createStore()
  const runtime = createConnectionsRuntime({ definitions: { executor: definition }, fetch: fetcher, store })
  return { fallbackCalls: () => fallbackCalls, keys, runtime, store }
}

describe("API key fallback", () => {
  it("uses the fallback key while no key was ever stored, and records the use", async () => {
    const test = harness(() => ` ${ENV_KEY}\n`)
    expect(await test.runtime.inspect("executor")).toMatchObject({ credential: "api-key", keySource: "fallback", status: "connected" })
    expect((await test.runtime.client("executor", {}).fetch(URL_ITEMS)).status).toBe(200)
    expect(test.keys).toEqual([`Bearer ${ENV_KEY}`])
    const activity = await test.runtime.activity({ name: "executor" })
    expect(activity.map(entry => [entry.action, entry.outcome, entry.revision])).toEqual(expect.arrayContaining([
      ["use", "started", "fallback"],
      ["use", "succeeded", "fallback"],
    ]))
    expect(JSON.stringify(activity)).not.toContain(ENV_KEY)
  })

  it("unseals a sealed Server Env secret", async () => {
    const test = harness(async () => new SecretEnv(ENV_KEY))
    await test.runtime.client("executor", {}).fetch(URL_ITEMS)
    expect(test.keys).toEqual([`Bearer ${ENV_KEY}`])
  })

  it("lets a stored key win over the fallback", async () => {
    const test = harness(() => ENV_KEY)
    expect(await test.runtime.setKey({ key: STORED_KEY, name: "executor" })).toMatchObject({ keySource: "stored", status: "connected" })
    const calls = test.fallbackCalls()
    await test.runtime.client("executor", {}).fetch(URL_ITEMS)
    expect(test.keys).toEqual([`Bearer ${STORED_KEY}`])
    expect(test.fallbackCalls()).toBe(calls)
  })

  it("keeps a revoked Connection disconnected instead of falling back", async () => {
    const test = harness(() => ENV_KEY)
    expect(await test.runtime.revoke({ name: "executor" })).toMatchObject({ status: "revoked" })
    expect(await test.runtime.inspect("executor")).not.toHaveProperty("keySource")
    await expect(test.runtime.client("executor", {}).fetch(URL_ITEMS)).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })

    await test.runtime.setKey({ key: STORED_KEY, name: "executor" })
    await test.runtime.revoke({ name: "executor" })
    await expect(test.runtime.client("executor", {}).fetch(URL_ITEMS)).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(test.keys).toEqual([])
  })

  it("uses the fallback key when the store cannot open", async () => {
    const test = harness(() => ENV_KEY, { store: () => { throw new Error("Connections need VITEHUB_CONNECTIONS_KEY") } })
    expect(await test.runtime.inspect("executor")).toMatchObject({ keySource: "fallback", status: "connected" })
    expect((await test.runtime.client("executor", {}).fetch(URL_ITEMS)).status).toBe(200)
    expect(test.keys).toEqual([`Bearer ${ENV_KEY}`])
  })

  it("does not fall back when an open store fails to read the Connection state", async () => {
    const store = createStore()
    const test = harness(() => ENV_KEY, { store })
    store.state.get = async () => { throw new Error("state unavailable") }
    await expect(test.runtime.client("executor", {}).fetch(URL_ITEMS)).rejects.toThrow("state unavailable")
    expect(test.keys).toEqual([])
  })

  it("rejects a fallback key that fails the key format check, without exposing it", async () => {
    const test = harness(() => "has space")
    expect(await test.runtime.inspect("executor")).toMatchObject({ status: "disconnected" })
    expect(await test.runtime.inspect("executor")).not.toHaveProperty("keySource")
    const error = await test.runtime.client("executor", {}).fetch(URL_ITEMS).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: "CONNECTION_INVALID" })
    expect(String(error)).not.toContain("has space")
    expect(test.keys).toEqual([])
  })

  it("reports no key when the fallback is empty or fails during inspection", async () => {
    expect(await harness(() => undefined).runtime.inspect("executor")).toMatchObject({ status: "disconnected" })
    const failing = harness(() => { throw new Error("missing env") })
    expect(await failing.runtime.inspect("executor")).toMatchObject({ status: "disconnected" })
    await expect(failing.runtime.client("executor", {}).fetch(URL_ITEMS)).rejects.toThrow("missing env")
  })

  it("binds an approval to the fallback key and replays it with that key", async () => {
    const test = harness(() => ENV_KEY, { access: { "agent:support": { read: true, write: ["fetch"] } } })
    const agent = test.runtime.client("executor", { access: agentEnvAccess({ name: "support" }) })
    await expect(agent.fetch(URL_ITEMS, { body: "{}", method: "POST" })).rejects.toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    const [approval] = (await test.runtime.approvals({ name: "executor", status: "pending" })).approvals
    expect(approval!.input).toMatchObject({ grantId: "fallback" })
    expect(await test.runtime.approve({ id: approval!.id })).toMatchObject({ approval: { status: "executed" }, result: { status: 200 } })
    expect(test.keys).toEqual([`Bearer ${ENV_KEY}`])
  })

  it("does not replay a fallback approval after an admin stores a key", async () => {
    const test = harness(() => ENV_KEY, { access: { "agent:support": { read: true, write: ["fetch"] } } })
    const agent = test.runtime.client("executor", { access: agentEnvAccess({ name: "support" }) })
    await expect(agent.fetch(URL_ITEMS, { body: "{}", method: "POST" })).rejects.toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    const [approval] = (await test.runtime.approvals({ name: "executor", status: "pending" })).approvals
    await test.runtime.setKey({ key: STORED_KEY, name: "executor" })
    await expect(test.runtime.approve({ id: approval!.id })).rejects.toThrow("previous Connection grant")
    expect(test.keys).toEqual([])
  })
})
