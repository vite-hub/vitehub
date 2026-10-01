import { expect, it } from "vitest"

import { createConnectionsRuntime } from "../src/runtime.ts"
import { connect, createTestRuntime, mailConnection } from "./helpers.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it("serializes rotating refresh grants across independent runtimes", async () => {
  const test = createTestRuntime()
  await connect(test, { expires_in: 1 })
  const entered = deferred()
  const release = deferred()
  let refreshCalls = 0
  const providerFetch: typeof fetch = async (input, init) => {
    if (String(input) === "https://auth.example.com/token" && String(init?.body).includes("grant_type=refresh_token")) {
      if (++refreshCalls > 1) return Response.json({ error: "invalid_grant" }, { status: 400 })
      entered.resolve()
      await release.promise
      test.provider.valid.clear()
      test.provider.valid.add("rotated-access")
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    }
    return await test.provider.fetch(input, init)
  }
  const options = { definitions: { mail: mailConnection() }, fetch: providerFetch, now: () => test.now.value, store: test.store }
  const first = createConnectionsRuntime(options)
  const second = createConnectionsRuntime({ ...options, store: { ...test.store } })
  const calls = Promise.allSettled([
    first.client("mail", {}).call("mail.labels.list", { userId: "me" }),
    second.client("mail", {}).call("mail.labels.list", { userId: "me" }),
  ])
  await entered.promise
  await new Promise(resolve => setTimeout(resolve, 50))
  release.resolve()
  expect((await calls).map(result => result.status)).toEqual(["fulfilled", "fulfilled"])
  expect(refreshCalls).toBe(1)
})

it("requires reconnect after an expired refresh for the same token revision", async () => {
  const test = createTestRuntime()
  await connect(test, { expires_in: 1 })
  const token = await test.store.secrets.read("connection/mail")
  if (!token?.revision) throw new Error("Expected connected token revision")
  await test.store.refreshLeases.claim({ expiresAt: test.now.value + 10, name: "mail", now: test.now.value, owner: "crashed-owner", revision: token.revision })
  const before = test.provider.calls.length
  test.now.value += 11
  await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  expect(test.provider.calls).toHaveLength(before)
  expect(await test.runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
})

it("fences release and refuses expired leases even for a newer token revision", async () => {
  const test = createTestRuntime()
  const leases = test.store.refreshLeases
  const first = { expiresAt: 10, name: "mail", now: 0, owner: "first", revision: "old-token" }
  expect(await leases.claim(first)).toBe("acquired")
  expect(await leases.claim({ ...first, owner: "second" })).toBe("busy")
  expect(await leases.claim({ ...first, expiresAt: 30, now: 20, owner: "second" })).toBe("expired")
  const next = { ...first, expiresAt: 30, now: 20, owner: "second", revision: "new-token" }
  expect(await leases.claim(next)).toBe("expired")
  await leases.release("mail", "second")
  expect(await leases.claim({ ...next, owner: "third" })).toBe("expired")
  await leases.release("mail", "first")
  expect(await leases.claim({ ...next, owner: "third" })).toBe("acquired")
})

it("does not reuse a refresh grant when its replacement cannot be persisted", async () => {
  const test = createTestRuntime()
  await connect(test, { expires_in: 1 })
  const replace = test.store.bridge.replace
  test.store.bridge.replace = (context, input) => context.actor.id === "connections" ? Promise.reject(new Error("Token persistence unavailable")) : replace(context, input)
  test.provider.tokenResponses.push({ body: { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 } })
  await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toBeDefined()
  expect(await test.runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
  const count = test.provider.calls.length
  await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  expect(test.provider.calls).toHaveLength(count)
})
