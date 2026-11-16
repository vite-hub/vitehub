import { describe, expect, it } from "vitest"

import { createConnectionsHandler } from "../src/http.ts"
import { connectionsOperations } from "../src/operations.ts"
import { setConnectionsRuntime } from "../src/runtime/state.ts"
import { ACCESS_TOKEN, createStore, createTestRuntime, mailConnection, REFRESH_TOKEN } from "./helpers.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { TestRuntime } from "./helpers.ts"

const app = "https://agents.example.com"

/** The context of a signed Console call that the app's `/_vitehub/rpc` received. */
function consoleCall(user = "u1"): OperationContext {
  return {
    access: { mode: "token", sections: "all" },
    request: new Request(`${app}/portal/_vitehub/rpc`, { method: "POST" }),
    surface: "console",
    user: { id: user },
  }
}

function operation(name: string) {
  const found = connectionsOperations.find(candidate => candidate.name === name)
  if (!found) throw new Error(`No operation ${name}`)
  return (input: unknown, context: OperationContext) => (found.run as (input: unknown, context: OperationContext) => Promise<unknown>)(input, context)
}

/** A management handler that denies every request, as a production build without `connections.management` has. */
function productionHandler(test: TestRuntime) {
  return createConnectionsHandler({ actor: () => undefined, basePath: "/portal/_vitehub/connections", runtime: () => test.runtime })
}

describe("Connections in the Console", () => {
  it("connects through the app's callback without an app session", async () => {
    const test = createTestRuntime()
    setConnectionsRuntime({ definitions: { mail: mailConnection() }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
    const started = await operation("connections.connect")({ name: "mail" }, consoleCall()) as { url: string }
    const authorize = new URL(started.url)
    expect(authorize.origin + authorize.pathname).toBe("https://auth.example.com/authorize")
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${app}/portal/_vitehub/connections/callback`)

    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN, token_type: "Bearer" } })
    // The provider sends the browser back without the state cookie, and the policy denies every app request.
    const callback = await productionHandler(test).fetch(new Request(`${app}/portal/_vitehub/connections/callback?code=code-1&state=${authorize.searchParams.get("state")}`))
    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain("mail is connected as owner@example.com.")

    const [connection] = await operation("connections.list")({}, consoleCall()) as Array<{ status: string, account: string }>
    expect(connection).toMatchObject({ account: "owner@example.com", id: "mail", status: "connected" })
    const activity = await test.runtime.activity({ name: "mail" })
    expect(activity.some(event => event.action === "replace" && event.actor.id === "u1")).toBe(true)
    setConnectionsRuntime(undefined)
  })

  it("keeps the browser check for flows that the app started", async () => {
    const test = createTestRuntime()
    const { state } = await test.runtime.authorize({ actor: "user:owner", name: "mail", redirectUri: `${app}/portal/_vitehub/connections/callback` })
    const callback = await productionHandler(test).fetch(new Request(`${app}/portal/_vitehub/connections/callback?code=code-1&state=${state}`))
    expect(callback.status).toBe(403)
    await expect(test.runtime.complete({ code: "code-1", state })).rejects.toMatchObject({ code: "CONNECTIONS_INVALID_ACTOR" })
  })

  it("completes a Console flow once", async () => {
    const test = createTestRuntime(mailConnection(), createStore())
    const { state } = await test.runtime.authorize({ actor: "user:u1", name: "mail", redirectUri: `${app}/_vitehub/connections/callback`, via: "console" })
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, id_token: "account-1", token_type: "Bearer" } })
    const handler = createConnectionsHandler({ actor: () => undefined, runtime: () => test.runtime })
    expect((await handler.fetch(new Request(`${app}/_vitehub/connections/callback?code=code-1&state=${state}`))).status).toBe(200)
    const replay = await handler.fetch(new Request(`${app}/_vitehub/connections/callback?code=code-1&state=${state}`))
    expect(replay.status).toBe(400)
    expect(await replay.text()).toContain("CONNECTIONS_AUTHORIZATION_EXPIRED")
  })

  it("revokes as the Console user", async () => {
    const test = createTestRuntime()
    setConnectionsRuntime({ definitions: { mail: mailConnection() }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
    const { state } = await test.runtime.authorize({ actor: "user:u1", name: "mail", redirectUri: `${app}/_vitehub/connections/callback`, via: "console" })
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, id_token: "account-1", refresh_token: REFRESH_TOKEN, token_type: "Bearer" } })
    await test.runtime.complete({ code: "code-1", state })
    expect(await operation("connections.revoke")({ name: "mail" }, consoleCall("u2"))).toMatchObject({ status: "revoked" })
    const activity = await test.runtime.activity({ name: "mail" })
    expect(activity.some(event => event.operation === "revoke" && event.actor.id === "u2")).toBe(true)
    setConnectionsRuntime(undefined)
  })
})
