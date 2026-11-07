import { DatabaseSync } from "node:sqlite"
import { getMigrations } from "better-auth/db/migration"
import { admin } from "better-auth/plugins"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { adminClaimHash, createAdminClaimCode } from "../src/admin-claim-code.ts"
import { createAuthConsole } from "../src/console-runtime.ts"
import { createAuthForRequest, createBetterAuthOptions, resetAuth } from "../src/server.ts"
import { hubAuth } from "../src/vite.ts"
import { runViteHubCli } from "../../cli/src/index.ts"

const origin = "https://app.example.com"

afterEach(() => {
  vi.unstubAllEnvs()
  resetAuth()
})

type Auth = ReturnType<typeof createAuthForRequest>

/** Signs up with email and password and returns the session cookie. */
async function signUp(auth: Auth, email: string): Promise<string> {
  const response = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email, name: email, password: "correct-horse-battery" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
}

async function claim(auth: Auth, cookie: string, code: string): Promise<Response> {
  return await auth.handler(new Request(`${origin}/api/auth/vitehub/admin-claim`, {
    body: JSON.stringify({ code }),
    headers: { "content-type": "application/json", cookie, origin },
    method: "POST",
  }))
}

async function available(auth: Auth, cookie: string): Promise<unknown> {
  const response = await auth.handler(new Request(`${origin}/api/auth/vitehub/admin-claim/status`, { headers: { cookie } }))
  expect(response.status).toBe(200)
  return (await response.json() as { available: unknown }).available
}

async function roleOf(auth: Auth, email: string): Promise<unknown> {
  const found = await (await auth.$context).internalAdapter.findUserByEmail(email)
  return found ? Reflect.get(found.user, "role") : undefined
}

async function authWithCode() {
  const code = createAdminClaimCode()
  vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(code))
  const auth = createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()] }), new Request(origin))
  return { auth, code }
}

describe("VITEHUB_ADMIN_CLAIM", () => {
  it("makes codes of 16 Crockford Base32 characters whose hash ignores case and dashes", async () => {
    const code = createAdminClaimCode()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
    expect(createAdminClaimCode()).not.toBe(code)
    expect(await adminClaimHash(code.toLowerCase().replaceAll("-", " "))).toBe(await adminClaimHash(code))
  })

  it("gives the admin role to the signed-in user who enters the code, once", async () => {
    const { auth, code } = await authWithCode()
    const owner = await signUp(auth, "owner@example.com")
    expect(await roleOf(auth, "owner@example.com")).toBe("user")
    expect(await available(auth, owner)).toBe(true)

    const response = await claim(auth, owner, code)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ role: "admin" })
    expect(await roleOf(auth, "owner@example.com")).toBe("admin")
    expect(await available(auth, owner)).toBe(false)

    const guest = await signUp(auth, "guest@example.com")
    expect((await claim(auth, guest, code)).status).toBe(409)
    expect(await roleOf(auth, "guest@example.com")).toBe("user")
  })

  it("refuses a wrong code and keeps the code available", async () => {
    const { auth } = await authWithCode()
    const cookie = await signUp(auth, "guest@example.com")
    expect((await claim(auth, cookie, createAdminClaimCode())).status).toBe(403)
    expect(await roleOf(auth, "guest@example.com")).toBe("user")
    expect(await available(auth, cookie)).toBe(true)
  })

  it("needs a session", async () => {
    const { auth, code } = await authWithCode()
    expect((await claim(auth, "", code)).status).toBe(401)
  })

  it("lets only one of two requests at the same time use the code", async () => {
    const { auth, code } = await authWithCode()
    const first = await signUp(auth, "first@example.com")
    const second = await signUp(auth, "second@example.com")
    const statuses = (await Promise.all([claim(auth, first, code), claim(auth, second, code)])).map(response => response.status).sort()
    expect(statuses).toEqual([200, 409])
  })

  it("lets only one of two Auth instances on one SQLite database use the code", async () => {
    const code = createAdminClaimCode()
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(code))
    const sqlite = new DatabaseSync(":memory:")
    // Two Definitions build two Auth instances with their own plugin state, as two Workers would.
    const instance = () => defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()], runtime: { database: sqlite, secret: "admin-claim-test-secret-1234567890abcdef", baseURL: origin } })
    const [one, two] = [instance(), instance()]
    await (await getMigrations(createBetterAuthOptions(one))).runMigrations()
    const [authOne, authTwo] = [createAuthForRequest(one, new Request(origin)), createAuthForRequest(two, new Request(origin))]
    const first = await signUp(authOne, "first@example.com")
    const second = await signUp(authTwo, "second@example.com")
    const statuses = (await Promise.all([claim(authOne, first, code), claim(authTwo, second, code)])).map(response => response.status).sort()
    expect(statuses).toEqual([200, 409])
    sqlite.close()
  })

  it("shows the rule in the Auth Console", async () => {
    const { auth } = await authWithCode()
    const [error, description] = await createAuthConsole(auth).describe()
    expect(error).toBeUndefined()
    expect(description?.access).toContain("VITEHUB_ADMIN_CLAIM gives the admin role to the first signed-in user who enters its code.")
  })

  it.each(["7KQF-2M9D-XW4P-R8TB", "sha256:abc"])("refuses %s as the variable value", (value) => {
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", value)
    expect(() => createAuthForRequest(defineAuth({ plugins: [admin()] }), new Request(origin))).toThrow(/AUTH_C0059|vitehub auth claim/)
  })

  it("needs Better Auth's admin() plugin, which stores the role", async () => {
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(createAdminClaimCode()))
    expect(() => createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true } }), new Request(origin))).toThrow(/AUTH_C0051|admin\(\)/)
  })
})

describe("vitehub auth claim", () => {
  it("prints a code and the hash to set on the host", async () => {
    const output: string[] = []
    const exit = await runViteHubCli({
      args: ["auth", "claim", "--json"],
      cwd: ".",
      env: {},
      loadConfig: async () => ({ root: ".", plugins: [hubAuth()], vitehubConfigResolved: true }),
      spawn: async () => ({ exitCode: 0 }),
      stderr: { write: () => true },
      stdout: { write: (value: string | Uint8Array) => output.push(String(value)) },
    })
    expect(exit).toBe(0)
    const printed = JSON.parse(output.join("")) as { code: string, variable: string, value: string }
    expect(printed.variable).toBe("VITEHUB_ADMIN_CLAIM")
    expect(printed.value).toBe(await adminClaimHash(printed.code))
  })
})
