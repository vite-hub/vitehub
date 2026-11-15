import { DatabaseSync } from "node:sqlite"
import { getMigrations } from "better-auth/db/migration"
import { admin } from "better-auth/plugins"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { adminClaimHash, createAdminClaimCode } from "../src/admin-claim-code.ts"
import { createAuthConsole } from "../src/console-runtime.ts"
import { createAuthForRequest, createBetterAuthOptions, resetAuth } from "../src/internal/server.ts"
import { hubAuth } from "../src/vite.ts"
import { runViteHubCli } from "../../cli/src/index.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

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

  it("refreshes the browser's cached session after a successful claim", async () => {
    const code = createAdminClaimCode()
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(code))
    const auth = createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()], session: { cookieCache: { enabled: true } } }), new Request(origin))
    const cookie = await signUp(auth, "owner@example.com")
    expect(cookie).toContain("better-auth.session_data=")
    const response = await claim(auth, cookie, code)
    expect(response.status).toBe(200)
    const cookies = new Map(cookie.split("; ").map(pair => [pair.slice(0, pair.indexOf("=")), pair]))
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0]!
      const name = pair.slice(0, pair.indexOf("="))
      if (/;\s*max-age=0(?:;|$)/i.test(header)) cookies.delete(name)
      else cookies.set(name, pair)
    }
    const session = await auth.handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie: [...cookies.values()].join("; ") } }))
    expect(await session.json()).toMatchObject({ user: { role: "admin" } })
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

  it("shares claim serialization between Auth instances for the same memory database", async () => {
    const code = createAdminClaimCode()
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(code))
    const definition = defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()] })
    const one = createAuthForRequest(definition, new Request(origin))
    const two = createAuthForRequest(definition, new Request(origin))
    const first = await signUp(one, "first@example.com")
    const second = await signUp(two, "second@example.com")
    const statuses = (await Promise.all([claim(one, first, code), claim(two, second, code)])).map(response => response.status).sort()
    expect(statuses).toEqual([200, 409])
    expect([await roleOf(one, "first@example.com"), await roleOf(two, "second@example.com")].sort()).toEqual(["admin", "user"])
  })

  it.each([undefined, false, true])("supports secondary storage with storeInDatabase set to %s", async (storeInDatabase) => {
    const code = createAdminClaimCode()
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(code))
    const cache = new Map<string, string>()
    const definition = defineFixedAuth({
      emailAndPassword: { enabled: true },
      plugins: [admin()],
      verification: { storeInDatabase, storeIdentifier: "hashed" },
      secondaryStorage: {
        get: async key => cache.get(key) ?? null,
        set: async (key, value) => { cache.set(key, value) },
        delete: async (key) => { cache.delete(key) },
        getAndDelete: async (key) => {
          const value = cache.get(key) ?? null
          cache.delete(key)
          return value
        },
        increment: async (key) => {
          const value = Number(cache.get(key) ?? 0) + 1
          cache.set(key, String(value))
          return value
        },
      },
    })
    const auth = createAuthForRequest(definition, new Request(origin))
    const cookie = await signUp(auth, "owner@example.com")
    expect((await claim(auth, cookie, code)).status).toBe(200)
    expect(await roleOf(auth, "owner@example.com")).toBe("admin")
    expect(await available(auth, cookie)).toBe(false)
    expect((await claim(auth, cookie, code)).status).toBe(409)
    expect(createBetterAuthOptions(definition).verification).toMatchObject({ storeInDatabase: true, storeIdentifier: "hashed" })
  })

  it.each(["throw", "cancel", "missing"] as const)("keeps the code available when the role update fails (%s)", async (failure) => {
    const { auth, code } = await authWithCode()
    const cookie = await signUp(auth, "owner@example.com")
    const adapter = (await auth.$context).internalAdapter
    const update = vi.spyOn(adapter, "updateUser")
    if (failure === "throw") update.mockRejectedValueOnce(new Error("database unavailable"))
    else if (failure === "cancel") vi.spyOn((await auth.$context).adapter, "update").mockResolvedValueOnce(null)
    else vi.spyOn(adapter, "findUserById").mockResolvedValueOnce(null)
    expect((await claim(auth, cookie, code)).status).toBeGreaterThanOrEqual(400)
    expect(await roleOf(auth, "owner@example.com")).toBe("user")
    expect(await available(auth, cookie)).toBe(true)
    expect((await claim(auth, cookie, code)).status).toBe(200)
    expect(await roleOf(auth, "owner@example.com")).toBe("admin")
    expect(await available(auth, cookie)).toBe(false)
  })

  it.each([false, true])("keeps claims independent of secondary-storage outages (failed grant: %s)", async (failGrant) => {
    const code = createAdminClaimCode()
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(code))
    const cache = new Map<string, string>()
    let unavailable = false
    const checkStorage = () => { if (unavailable) throw new Error("secondary storage unavailable") }
    const definition = defineFixedAuth({
      emailAndPassword: { enabled: true },
      plugins: [admin()],
      verification: { storeIdentifier: "hashed" },
      secondaryStorage: {
        get: async (key) => { checkStorage(); return cache.get(key) ?? null },
        set: async (key, value) => {
          // A reservation mirror fails after the durable insert, and all storage operations stay unavailable.
          if (key.startsWith("verification:")) unavailable = true
          checkStorage()
          cache.set(key, value)
        },
        delete: async (key) => { checkStorage(); cache.delete(key) },
        getAndDelete: async (key) => {
          checkStorage()
          const value = cache.get(key) ?? null
          cache.delete(key)
          return value
        },
        increment: async (key) => {
          checkStorage()
          const value = Number(cache.get(key) ?? 0) + 1
          cache.set(key, String(value))
          return value
        },
      },
    })
    const auth = createAuthForRequest(definition, new Request(origin))
    const owner = await signUp(auth, "owner@example.com")
    const guest = await signUp(auth, "guest@example.com")
    if (failGrant) {
      vi.spyOn((await auth.$context).internalAdapter, "updateUser").mockImplementationOnce(async () => {
        unavailable = true
        throw new Error("role update unavailable")
      })
    }
    expect((await claim(auth, owner, code)).status).toBe(failGrant ? 500 : 200)
    unavailable = false
    expect(await available(auth, owner)).toBe(failGrant)
    if (failGrant) expect((await claim(auth, owner, code)).status).toBe(200)
    expect(await roleOf(auth, "owner@example.com")).toBe("admin")
    expect((await claim(auth, guest, code)).status).toBe(409)
    expect(await roleOf(auth, "guest@example.com")).toBe("user")
  })

  it("keeps the reservation when an update error follows a completed role grant", async () => {
    const { auth, code } = await authWithCode()
    const cookie = await signUp(auth, "owner@example.com")
    const guest = await signUp(auth, "guest@example.com")
    const adapter = (await auth.$context).internalAdapter
    const update = adapter.updateUser.bind(adapter)
    vi.spyOn(adapter, "updateUser").mockImplementationOnce(async (...args) => {
      await update(...args)
      throw new Error("after hook failed")
    })
    expect((await claim(auth, cookie, code)).status).toBe(500)
    expect(await roleOf(auth, "owner@example.com")).toBe("admin")
    expect(await available(auth, cookie)).toBe(false)
    expect((await claim(auth, guest, code)).status).toBe(409)
    expect(await roleOf(auth, "guest@example.com")).toBe("user")
  })

  it("lets only one of two Auth instances on one SQLite database use the code", async () => {
    const code = createAdminClaimCode()
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(code))
    const sqlite = new DatabaseSync(":memory:")
    // Two Definitions build two Auth instances with their own plugin state, as two Workers would.
    const instance = () => defineFixedAuth({ emailAndPassword: { enabled: true }, plugins: [admin()], database: sqlite, secret: "admin-claim-test-secret-1234567890abcdef", baseURL: origin })
    const [one, two] = [instance(), instance()]
    await (await getMigrations(createBetterAuthOptions(one))).runMigrations()
    const [authOne, authTwo] = [createAuthForRequest(one, new Request(origin)), createAuthForRequest(two, new Request(origin))]
    const first = await signUp(authOne, "first@example.com")
    const second = await signUp(authTwo, "second@example.com")
    const statuses = (await Promise.all([claim(authOne, first, code), claim(authTwo, second, code)])).map(response => response.status).sort()
    expect(statuses).toEqual([200, 409])
    sqlite.close()
  })

  it("allows another SQLite Auth instance to retry after a failed role grant", async () => {
    const code = createAdminClaimCode()
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", await adminClaimHash(code))
    const sqlite = new DatabaseSync(":memory:")
    try {
      const instance = () => defineFixedAuth({ emailAndPassword: { enabled: true }, plugins: [admin()], database: sqlite, secret: "admin-claim-test-secret-1234567890abcdef", baseURL: origin })
      const [one, two] = [instance(), instance()]
      await (await getMigrations(createBetterAuthOptions(one))).runMigrations()
      const [authOne, authTwo] = [createAuthForRequest(one, new Request(origin)), createAuthForRequest(two, new Request(origin))]
      const first = await signUp(authOne, "first@example.com")
      const second = await signUp(authTwo, "second@example.com")
      vi.spyOn((await authOne.$context).internalAdapter, "updateUser").mockRejectedValueOnce(new Error("database unavailable"))
      expect((await claim(authOne, first, code)).status).toBe(500)
      expect(await available(authTwo, second)).toBe(true)
      expect((await claim(authTwo, second, code)).status).toBe(200)
      expect((await claim(authOne, first, code)).status).toBe(409)
      expect(await roleOf(authOne, "first@example.com")).toBe("user")
      expect(await roleOf(authTwo, "second@example.com")).toBe("admin")
    }
    finally {
      sqlite.close()
    }
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

  it.each([false, true])("ignores the host claim value when disabled in a callback=%s Definition", async (callback) => {
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", "not-a-hash")
    const options = { adminClaim: false as const, emailAndPassword: { enabled: true } }
    const definition = callback ? defineAuth(() => options) : defineAuth(options)
    const auth = createAuthForRequest(definition, new Request(origin))
    const cookie = await signUp(auth, "other@example.com")
    expect((await auth.handler(new Request(`${origin}/api/auth/vitehub/admin-claim/status`, { headers: { cookie } }))).status).toBe(404)
    expect((await claim(auth, cookie, createAdminClaimCode())).status).toBe(404)
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
