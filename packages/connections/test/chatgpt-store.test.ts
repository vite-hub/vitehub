import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { expect, it } from "vitest"
import { chatgpt } from "../src/chatgpt.ts"
import { defineConnection } from "../src/definition.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createDatabaseConnectionStore } from "../src/store.ts"
import { createChatGPTFake } from "./chatgpt-fake.ts"

it("keeps pending nonce, registration, host identity and encrypted tokens across database restarts", async () => {
  await mkdir(".vitest-tmp", { recursive: true })
  const directory = await mkdtemp(resolve(".vitest-tmp", "chatgpt-store-"))
  const path = join(directory, "connections.sqlite")
  const fake = await createChatGPTFake()
  let client = createClient({ url: `file:${path}` })
  const runtime = () => createConnectionsRuntime({
    definitions: { chatgpt: defineConnection({ provider: chatgpt({ appName: "Persistent app" }), access: { "agent:assistant": { read: true } } }) },
    store: createDatabaseConnectionStore({ db: drizzle(client), encryptionKey: new Uint8Array(32).fill(9) }),
    fetch: fake.fetch,
  })
  try {
    const before = runtime()
    const pending = await before.authorize({ name: "chatgpt", redirectUri: "http://127.0.0.1:1455/callback" })
    const host = (await before.inspect("chatgpt")).chatgpt?.hostId
    client.close()
    client = createClient({ url: `file:${path}` })
    const after = runtime()
    const callback = await fake.callback(pending.url)
    const connected = await after.complete({ state: pending.state, code: callback.searchParams.get("code")!, clientId: callback.searchParams.get("client_id")! })
    expect(connected).toMatchObject({ credential: "chatgpt", account: { email: "test@example.com" }, chatgpt: { hostId: host, plan: "enabled" }, expiresAt: expect.any(String) })
    client.close()
    client = createClient({ url: `file:${path}` })
    const restarted = runtime()
    expect(await restarted.inspect("chatgpt")).toEqual(connected)
    const returning = await restarted.authorize({ name: "chatgpt", redirectUri: "http://127.0.0.1:54321/callback" })
    expect(new URL(returning.url).searchParams.get("client_id")).toBe(connected.chatgpt?.clientId)
    expect(new URL(returning.url).searchParams.get("ext_agent_host_id")).toBe(host)
    await restarted.revoke({ name: "chatgpt" })
    expect((await restarted.inspect("chatgpt")).chatgpt).toEqual({ ...connected.chatgpt, plan: "disabled" })
    const bytes = await readFile(path)
    expect(bytes.includes("test-access-")).toBe(false)
    expect(bytes.includes("test-refresh-")).toBe(false)
  }
  finally {
    client.close()
    await fake.close()
    await rm(directory, { recursive: true, force: true })
  }
})
