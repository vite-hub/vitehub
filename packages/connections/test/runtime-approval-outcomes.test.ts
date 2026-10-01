import { expect, it } from "vitest"

import { createConnectionsHandler } from "../src/http.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { connect, createTestRuntime, mailConnection } from "./helpers.ts"

it.each([
  { kind: "method", stage: "network" },
  { kind: "fetch", stage: "network" },
  { kind: "method", stage: "malformed" },
  { kind: "method", stage: "audit" },
  { kind: "fetch", stage: "audit" },
  { kind: "method", stage: "approval state" },
  { kind: "fetch", stage: "approval state" },
  { kind: "method", stage: "server error" },
])("records an uncertain approved $kind write after $stage failure", async ({ kind, stage }) => {
  const definition = mailConnection({ "agent:writer": { read: true, write: ["mail.messages.modify", "fetch"] } })
  const test = createTestRuntime(definition)
  await connect(test)
  const client = test.runtime.client("mail", { actor: "agent:writer" })
  await expect(kind === "method"
    ? client.call("mail.messages.modify", { id: "m1", userId: "me" })
    : client.fetch("https://mail.example.com/mail/v1/users/me/messages/m1/modify", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
  const id = (await test.runtime.approvals({ status: "pending" })).approvals[0]!.id
  let effects = 0
  const runtime = createConnectionsRuntime({ definitions: { mail: definition }, store: test.store, now: () => test.now.value, fetch: async (input, init) => {
    const response = await test.provider.fetch(input, init)
    if (String(input).endsWith("/modify")) {
      effects++
      if (stage === "network") throw new TypeError("Provider response lost")
      if (stage === "malformed") return new Response("truncated successful response", { status: 200 })
      if (stage === "server error") return Response.json({ error: { message: "Provider failed after applying the write" } }, { status: 500 })
    }
    return response
  } })
  if (stage === "audit") {
    const append = test.store.access.append
    test.store.access.append = async event => {
      if (event.action === "use" && event.outcome === "succeeded") throw new Error("Audit persistence unavailable")
      await append(event)
    }
  }
  if (stage === "approval state") {
    const transition = test.store.approvals.transition
    test.store.approvals.transition = async (...args) => {
      if (args[2] === "executed") throw new Error("Approval persistence unavailable")
      return await transition(...args)
    }
  }
  if (kind === "fetch" && stage === "network") {
    const handler = createConnectionsHandler({ actor: () => "user:owner", runtime: () => runtime })
    const response = await handler(new Request("http://localhost/_vitehub/connections", { body: JSON.stringify({ action: "approve", id }), headers: { origin: "http://localhost", "content-type": "application/json" }, method: "POST" }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "CONNECTION_EXECUTION_UNKNOWN", requestId: id } })
  }
  else await expect(runtime.approve({ id })).rejects.toMatchObject({ code: "CONNECTION_EXECUTION_UNKNOWN", requestId: id })
  expect(effects).toBe(1)
  expect(await test.store.approvals.get(id)).toMatchObject({ error: "CONNECTION_EXECUTION_UNKNOWN", status: "failed" })
  await expect(runtime.approve({ id })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
  expect(effects).toBe(1)
})

it("preserves a confirmed provider rejection when an approved write returns HTTP 400", async () => {
  const test = createTestRuntime(mailConnection({ "agent:writer": { read: true, write: ["mail.messages.modify"] } }))
  await connect(test)
  await expect(test.runtime.client("mail", { actor: "agent:writer" }).call("mail.messages.modify", { id: "m1", userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
  const id = (await test.runtime.approvals({ status: "pending" })).approvals[0]!.id
  const runtime = createConnectionsRuntime({ definitions: { mail: mailConnection() }, store: test.store, now: () => test.now.value, fetch: async (input, init) =>
    String(input).endsWith("/modify") ? Response.json({ error: { message: "Invalid label" } }, { status: 400 }) : await test.provider.fetch(input, init) })
  await expect(runtime.approve({ id })).rejects.toMatchObject({ code: "CONNECTION_PROVIDER" })
  expect(await test.store.approvals.get(id)).toMatchObject({ error: "CONNECTION_PROVIDER", status: "failed" })
})
