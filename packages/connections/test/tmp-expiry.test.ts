import { expect, it } from "vitest"
import { createTestRuntime, mailConnection } from "./helpers.ts"

it("rejects an authorization at its exact expiry boundary", async () => {
  const test = createTestRuntime(mailConnection())
  const { state } = await test.runtime.authorize({ name: "mail", redirectUri: "http://127.0.0.1:8976/callback" })
  const authorization = await test.store.authorizations.take(state)
  if (!authorization) throw new Error("missing authorization")
  await test.store.authorizations.put({ ...authorization, expiresAt: test.now.value })
  await expect(test.runtime.complete({ code: "code", state })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
  expect(test.provider.calls).toEqual([])
})
