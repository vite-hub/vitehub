import { expect, it } from "vitest"
import { createTestRuntime, mailConnection } from "./helpers.ts"

it("rejects an authorization at its exact expiry boundary", async () => {
  const test = createTestRuntime(mailConnection())
  const { state } = await test.runtime.authorize({ actor: "user:owner", name: "mail", redirectUri: "http://127.0.0.1:8976/callback" })
  const authorization = await test.store.authorizations.take(state)
  if (!authorization) throw new Error("missing authorization")
  const expiresAt = Date.now() + 60_000
  test.now.value = expiresAt
  await test.store.authorizations.put({ ...authorization, expiresAt })
  await expect(test.runtime.complete({ actor: "user:owner", code: "code", state })).rejects.toMatchObject({ code: "CONNECTIONS_AUTHORIZATION_EXPIRED" })
  expect(test.provider.calls).toEqual([])
})
