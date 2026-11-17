import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { admin } from "better-auth/plugins"
import { afterAll, beforeEach, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"
import { stateless } from "../src/presets.ts"
import { requireAuth } from "../src/server.ts"
import { signIn } from "../src/test.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

const definition = defineAuth({ appName: "Signup", plugins: [admin()] })
const mode = enableViteHubTestMode()

beforeEach(() => mode.reset())
afterAll(() => mode.reset())

function me(headers?: Headers) {
  return requireAuth(new Request("http://localhost/api/me", headers ? { headers } : {}), definition)
}

it("signs in a new user with a session that requireAuth() accepts", async () => {
  const { cookie, headers, user } = await signIn({ email: "ada@example.com", name: "Ada", role: "admin" }, definition)

  expect(cookie).toBe(headers.get("cookie"))
  expect(user).toMatchObject({ email: "ada@example.com", name: "Ada", role: "admin" })
  await expect(me(headers)).resolves.toMatchObject({ user: { id: user.id, role: "admin" } })
  await expect(me()).rejects.toMatchObject({ status: 401 })
})

it("signs in the user that has the email, and reset() removes users and sessions", async () => {
  const first = await signIn({ email: "ada@example.com" }, definition)
  const second = await signIn({ email: "ada@example.com" }, definition)
  expect(second.user.id).toBe(first.user.id)
  expect(second.session.id).not.toBe(first.session.id)

  await mode.reset()

  await expect(me(first.headers)).rejects.toMatchObject({ status: 401 })
  expect((await signIn({ email: "ada@example.com" }, definition)).user.id).not.toBe(first.user.id)
})

it("explains that a stateless() Definition has no database to sign in to", async () => {
  const statelessDefinition = defineFixedAuth({ preset: stateless(), secret: "a".repeat(32), socialProviders: { github: { clientId: "id", clientSecret: "secret" } } })

  await expect(signIn({ email: "ada@example.com" }, statelessDefinition)).rejects.toMatchObject({ code: "AUTH_TEST_SIGN_IN_STATELESS" })
})
