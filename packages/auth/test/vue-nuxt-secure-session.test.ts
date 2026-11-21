import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/definition.ts"
import { handleAuthRequest, resetAuth } from "../src/internal/server.ts"

import type { AuthDefinition } from "../src/types.ts"
import type { AuthPageMeta } from "../src/nuxt-types.ts"

type Route = { fullPath: string, meta: { auth?: AuthPageMeta } }
type PageEvent = { url: URL, req: Request, res: { headers: Headers } }

const nuxt = vi.hoisted(() => ({
  event: undefined as PageEvent | undefined,
  middleware: undefined as ((route: Route) => unknown) | undefined,
  state: { value: undefined as unknown },
}))

const nitro = vi.hoisted(() => ({ serverFetch: vi.fn<(request: Request) => Promise<Response>>() }))
vi.mock("nitro", () => nitro)

vi.mock("#app", () => ({
  addRouteMiddleware: (_name: string, middleware: (route: Route) => unknown) => { nuxt.middleware = middleware },
  createError: (input: unknown) => Object.assign(new Error("nuxt"), input),
  defineNuxtPlugin: (plugin: unknown) => plugin,
  navigateTo: (target: unknown) => target,
  showError: (input: unknown) => input,
  tryUseNuxtApp: () => ({ runWithContext: <T>(run: () => T) => run(), payload: {} }),
  useRequestEvent: () => nuxt.event,
  useRequestFetch: () => async (path: string, options: { onResponse?: (context: { response: Response }) => void }) => {
    const headers = new Headers(nuxt.event!.req.headers)
    headers.delete("host")
    const response = await nitro.serverFetch(new Request(`http://localhost${path}`, { headers }))
    options.onResponse?.({ response })
    if (!response.ok) throw new Error(String(response.status))
    return await response.json() as unknown
  },
  useRouter: () => ({ currentRoute: { value: { fullPath: "/", meta: {} } } }),
  useRuntimeConfig: () => ({ public: { vitehubAuth: { basePath: "/api/auth", signInPage: "/login", afterSignIn: "/" } } }),
  useState: () => nuxt.state,
}))

const secret = "abcdefghijklmnopqrstuvwxyz0123456789"
const site = "https://app.example.com"

afterEach(() => {
  resetAuth()
  vi.unstubAllGlobals()
  vi.resetModules()
  nitro.serverFetch.mockReset()
  nuxt.event = undefined
  nuxt.middleware = undefined
  nuxt.state = { value: undefined }
})

async function signUp(definition: AuthDefinition, url: string, headers: Record<string, string>): Promise<{ cookie: string, names: string[] }> {
  const response = await handleAuthRequest(definition, new Request(`${url}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin: site, ...headers },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  const pairs = response.headers.getSetCookie().map(cookie => cookie.split(";", 1)[0]!)
  return { cookie: pairs.join("; "), names: pairs.map(pair => pair.slice(0, pair.indexOf("="))) }
}

type Database = ReturnType<typeof memoryAdapter>
const options = (database: Database) => ({ database, emailAndPassword: { enabled: true }, secret })

describe("Nuxt page guard on an https site", () => {
  it.each([
    { name: "a base URL that Auth infers from the request", auth: (database: Database) => defineAuth(() => options(database)) },
    { name: "baseURL: requestOrigin", auth: (database: Database) => defineAuth(({ requestOrigin }) => ({ ...options(database), baseURL: requestOrigin })) },
    { name: "vitehub({ publicUrl })", publicUrl: { url: site }, auth: (database: Database) => defineAuth(() => options(database)) },
    {
      name: "a publicUrl origin for each Agent",
      publicUrl: { agents: { support: site, sales: "https://sales.example.com" } },
      auth: (database: Database) => defineAuth(() => options(database)),
    },
    {
      name: "a TLS proxy that Auth trusts",
      url: "http://127.0.0.1:3000",
      headers: { "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" },
      auth: (database: Database) => defineAuth(() => ({ ...options(database), advanced: { trustedProxyHeaders: true } })),
    },
  ])("lets a signed-in visitor open a guarded page with $name", async ({ auth, publicUrl, url = site, headers = {} }) => {
    if (publicUrl) vi.stubGlobal("__VITEHUB_PUBLIC_URL__", publicUrl)
    const definition = auth(memoryAdapter({ account: [], session: [], user: [], verification: [] }))
    nitro.serverFetch.mockImplementation(request => handleAuthRequest(definition, request))
    const { cookie, names } = await signUp(definition, url, headers)
    expect(names).toContain("__Secure-better-auth.session_token")

    const request = new Request(`${url}/private`, { headers: { accept: "text/html", cookie, host: new URL(url).host, ...headers } })
    nuxt.event = {
      url: new URL(request.url),
      req: request,
      res: { headers: new Headers() },
    }
    const { default: plugin } = await import("../src/runtime/vue-nuxt.ts") as { default: { setup: (app: { payload: object }) => void } }
    plugin.setup({ payload: {} })

    expect(await nuxt.middleware!({ fullPath: "/private", meta: { auth: "user" } })).toBeUndefined()
    expect(nuxt.state.value).toMatchObject({ user: { email: "ada@example.com" } })
  })
})
