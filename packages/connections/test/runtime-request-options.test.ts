import { expect, it, vi } from "vitest"

import { isConnectionError } from "../src/errors.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { connect, createTestRuntime, mailConnection } from "./helpers.ts"

it.each(["manual", "error"] as const)("preserves fetch redirect %s through approval replay", async (redirect) => {
  const definition = mailConnection({ "agent:labeller": { read: true, write: ["fetch"] } })
  const test = createTestRuntime(definition)
  const fetch = vi.fn(test.provider.fetch)
  const runtime = createConnectionsRuntime({ definitions: { mail: definition }, fetch, store: test.store, now: () => test.now.value })
  await connect({ ...test, runtime })
  await runtime.client("mail", { actor: "agent:labeller" }).fetch("https://mail.example.com/mail/v1/users/me/labels", { redirect })
  expect(fetch.mock.calls.at(-1)?.[1]?.redirect).toBe(redirect)
  const error: unknown = await runtime.client("mail", { actor: "agent:labeller" }).fetch("https://mail.example.com/mail/v1/users/me/messages/m1/modify", { body: "{}", method: "POST", redirect }).catch(error => error)
  expect(isConnectionError(error)).toBe(true)
  if (!isConnectionError(error) || !error.requestId) throw new Error("Expected approval request")
  await runtime.approve({ id: error.requestId })
  expect(fetch.mock.calls.at(-1)?.[1]?.redirect).toBe(redirect)
})

it("keeps OAuth state, PKCE, client, redirect, and scopes authoritative over provider extras", async () => {
  const definition = mailConnection()
  const test = createTestRuntime({
    ...definition,
    provider: {
      ...definition.provider,
      authorizationParams: {
        access_type: "offline",
        client_id: "wrong-client",
        code_challenge: "wrong-challenge",
        code_challenge_method: "plain",
        redirect_uri: "https://wrong.example/callback",
        response_type: "token",
        scope: "wrong.scope",
        state: "wrong-state",
      },
    },
  })
  const { state, url } = await test.runtime.authorize({ name: "mail", redirectUri: "http://127.0.0.1:8976/callback" })
  const params = new URL(url).searchParams
  expect(params.get("state")).toBe(state)
  expect(params.get("client_id")).toBe("client-id")
  expect(params.get("code_challenge")).not.toBe("wrong-challenge")
  expect(params.get("code_challenge_method")).toBe("S256")
  expect(params.get("redirect_uri")).toBe("http://127.0.0.1:8976/callback")
  expect(params.get("response_type")).toBe("code")
  expect(params.get("scope")).toBe("openid mail.modify")
  expect(params.get("access_type")).toBe("offline")
})
