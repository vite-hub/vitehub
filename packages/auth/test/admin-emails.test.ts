import { admin } from "better-auth/plugins"
import { createAccessControl } from "better-auth/plugins/access"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuthConsole } from "../src/console-runtime.ts"
import { createAuthForRequest, resetAuth } from "../src/server.ts"

const origin = "https://app.example.com"

afterEach(() => {
  vi.unstubAllEnvs()
  resetAuth()
})

async function signUpResponse(definition: Parameters<typeof createAuthForRequest>[0], email: string) {
  return await createAuthForRequest(definition, new Request(origin)).handler(new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email, name: email, password: "correct-horse-battery" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
}

async function signUp(definition: Parameters<typeof createAuthForRequest>[0], email: string) {
  const response = await signUpResponse(definition, email)
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  return (body as { user: { role?: string } }).user
}

describe("VITEHUB_ADMIN_EMAILS", () => {
  it("gives the admin role to new accounts with a listed email", async () => {
    vi.stubEnv("VITEHUB_ADMIN_EMAILS", " Owner@Example.com ,second@example.com")
    const definition = defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()] })
    expect((await signUp(definition, "owner@example.com")).role).toBe("admin")
    expect((await signUp(definition, "second@example.com")).role).toBe("admin")
    expect((await signUp(definition, "guest@example.com")).role).toBe("user")
  })

  it("uses the first admin role of admin()", async () => {
    vi.stubEnv("VITEHUB_ADMIN_EMAILS", "owner@example.com")
    const ac = createAccessControl({ user: ["list"] })
    const definition = defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin({ ac, adminRoles: ["owner"], roles: { owner: ac.newRole({ user: ["list"] }), user: ac.newRole({}) } })] })
    expect((await signUp(definition, "owner@example.com")).role).toBe("owner")
  })

  it("keeps the admin assignment after an application user-create hook", async () => {
    vi.stubEnv("VITEHUB_ADMIN_EMAILS", "owner@example.com")
    const before = vi.fn(async () => ({ data: { role: "user", name: "From app hook" } }))
    const definition = defineAuth({
      databaseHooks: { user: { create: { before } } },
      emailAndPassword: { enabled: true },
      plugins: [admin()],
    })
    expect(await signUp(definition, "owner@example.com")).toMatchObject({ role: "admin", name: "From app hook" })
    expect((await signUp(definition, "guest@example.com")).role).toBe("user")
    expect(before).toHaveBeenCalledTimes(2)
  })

  it.each([true, undefined])("keeps the admin assignment when the application hook returns %s", async (result) => {
    vi.stubEnv("VITEHUB_ADMIN_EMAILS", "owner@example.com")
    const definition = defineAuth({
      databaseHooks: { user: { create: { before: async () => result } } },
      emailAndPassword: { enabled: true },
      plugins: [admin()],
    })
    expect((await signUp(definition, "owner@example.com")).role).toBe("admin")
  })

  it("preserves application cancellation of an admin sign-up", async () => {
    vi.stubEnv("VITEHUB_ADMIN_EMAILS", "owner@example.com")
    const definition = defineAuth({
      databaseHooks: { user: { create: { before: async () => false } } },
      emailAndPassword: { enabled: true },
      plugins: [admin()],
    })
    expect((await signUpResponse(definition, "owner@example.com")).ok).toBe(false)
  })

  it("shows the rule in the Auth Console", async () => {
    vi.stubEnv("VITEHUB_ADMIN_EMAILS", "owner@example.com")
    const auth = createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()] }), new Request(origin))
    const [error, description] = await createAuthConsole(auth).describe()
    expect(error).toBeUndefined()
    expect(description?.access).toContain("VITEHUB_ADMIN_EMAILS gives the admin role to new accounts of owner@example.com.")
  })

  it("needs Better Auth's admin() plugin, which stores the role", async () => {
    vi.stubEnv("VITEHUB_ADMIN_EMAILS", "owner@example.com")
    const definition = defineAuth({ emailAndPassword: { enabled: true } })
    expect(() => createAuthForRequest(definition, new Request(origin))).toThrow(/AUTH_C0051|admin\(\)/)
  })

  it("changes nothing when the variable is not set", async () => {
    const definition = defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()] })
    expect((await signUp(definition, "owner@example.com")).role).toBe("user")
  })
})
