import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { authForRequest } from "../src/auth-instance.ts"
import { defineAuth } from "../src/definition.ts"
import { handleAuthRequest, requireAuth, requireAuthorization, resetAuth } from "../src/internal/server.ts"
import authClientRequestPlugin from "../src/runtime/client-request-plugin.ts"
import { resolveAuthOptions } from "../src/runtime-options.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

import type { AuthDefinition } from "../src/types.ts"

const secret = "abcdefghijklmnopqrstuvwxyz0123456789"
const site = "https://app.example.com"

afterEach(() => {
  resetAuth()
  vi.unstubAllGlobals()
})

async function signUp(definition: AuthDefinition, url: string, headers: Record<string, string>): Promise<string> {
  const response = await handleAuthRequest(definition, new Request(`${url}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin: site, ...headers },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]!).join("; ")
  expect(cookie).toContain("__Secure-better-auth.session_token=")
  return cookie
}

async function serve(client: Request, handle: () => Promise<void>): Promise<void> {
  const nitroApp = { fetch: async (_request: Request) => {
    await handle()
    return new Response()
  } }
  authClientRequestPlugin(nitroApp)
  await nitroApp.fetch(client)
}

type Database = ReturnType<typeof memoryAdapter>
const memory = () => memoryAdapter({ account: [], session: [], user: [], verification: [] })
const options = (database: Database) => ({ database, emailAndPassword: { enabled: true }, secret })

describe("server Auth helpers in a request that the server serves in process", () => {
  it.each([
    { name: "a base URL that Auth infers from the request", auth: (database: Database) => defineFixedAuth(options(database)) },
    { name: "baseURL: requestOrigin", auth: (database: Database) => defineAuth(({ requestOrigin }) => ({ ...options(database), baseURL: requestOrigin })) },
    { name: "vitehub({ publicUrl })", publicUrl: { url: site }, auth: (database: Database) => defineFixedAuth(options(database)) },
    {
      name: "a publicUrl origin for each Agent",
      publicUrl: { agents: { support: site, sales: "https://sales.example.com" } },
      auth: (database: Database) => defineFixedAuth(options(database)),
    },
    {
      name: "a TLS proxy that Auth trusts",
      url: "http://127.0.0.1:3000",
      headers: { "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" },
      auth: (database: Database) => defineFixedAuth({ ...options(database), advanced: { trustedProxyHeaders: true } }),
    },
  ])("read the session of an https page with $name", async ({ auth, publicUrl, url = site, headers = {} }) => {
    if (publicUrl) vi.stubGlobal("__VITEHUB_PUBLIC_URL__", publicUrl)
    const definition = auth(memory())
    const cookie = await signUp(definition, url, headers)
    const page = new Request(`${url}/items`, { headers: { accept: "text/html", cookie, host: new URL(url).host, ...headers } })
    const api = () => new Request("http://localhost/api/items", { headers: { cookie, ...headers } })

    await serve(page, async () => {
      expect((await requireAuth(api(), definition)).user.email).toBe("ada@example.com")
      expect((await requireAuthorization(api(), true, definition)).user.email).toBe("ada@example.com")
      const request = api()
      const session = await authForRequest(request, undefined, definition).api.getSession({ headers: request.headers })
      expect(session?.user.email).toBe("ada@example.com")
    })
  })

  it("reads the session at the URL of the request outside a client request", async () => {
    const definition = defineFixedAuth(options(memory()))
    const cookie = await signUp(definition, site, {})

    await expect(requireAuth(new Request("http://localhost/api/items", { headers: { cookie } }), definition)).rejects.toMatchObject({ status: 401 })
  })

  it("keeps the first client request for a nested request", async () => {
    const definition = defineFixedAuth(options(memory()))
    const cookie = await signUp(definition, site, {})
    const page = new Request(`${site}/items`, { headers: { cookie } })
    const api = new Request("http://localhost/api/items", { headers: { cookie } })

    await serve(page, () => serve(api, async () => {
      expect((await requireAuth(new Request("http://localhost/api/other", { headers: { cookie } }), definition)).user.email).toBe("ada@example.com")
    }))
  })

  it("keeps the origin of a request to another origin", async () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { support: site, sales: "https://sales.example.com" } })
    const definition = defineFixedAuth(options(memory()))
    const request = new Request("https://sales.example.com/api/items")

    await serve(new Request(`${site}/items`), async () => {
      expect(resolveAuthOptions(definition, { request }).options.baseURL).toBe("https://sales.example.com")
    })
  })
})
