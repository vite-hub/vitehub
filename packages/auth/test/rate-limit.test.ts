import { afterEach, describe, expect, it, vi } from "vitest"

import type { SecondaryStorage } from "better-auth"

import { authDatabase } from "../src/database.ts"
import { defineAuth } from "../src/definition.ts"
import { createAuthForRequest, createAuthHandler, createBetterAuthOptions, handleAuthRequest, resetAuth } from "../src/internal/server.ts"
import { requestEvent } from "./request-event.ts"

const secret = "abcdefghijklmnopqrstuvwxyz0123456789"
const definition = defineAuth(() => ({ database: "memory" as const, emailAndPassword: { enabled: true }, secret }))
let ipCounter = 0

/** A fresh client address, because Better Auth keeps memory counters in one module-level map. */
function nextAddress(): string {
  ipCounter += 1
  return `198.51.100.${ipCounter}`
}

/** A Cloudflare Worker: no `NODE_ENV`, and the Auth Vite plugin marked the bundle as a build. */
function workerRuntime() {
  vi.stubGlobal("__VITEHUB_AUTH_DEV__", false)
  vi.stubEnv("NODE_ENV", "")
}

function signIn(headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.com/api/auth/sign-in/email", {
    body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    headers: { "content-type": "application/json", origin: "https://app.example.com", ...headers },
    method: "POST",
  })
}

/** srvx adds `ip` to the Request of a Cloudflare Worker from `cf-connecting-ip`. */
function cloudflareRequest(address: string, headers: Record<string, string> = {}): Request {
  const request = signIn({ "cf-connecting-ip": address, ...headers })
  Object.defineProperty(request, "ip", { get: () => request.headers.get("cf-connecting-ip") })
  return request
}

/** An event with Standard Context, as ViteHub installs it for each Nitro request. */
function standardEvent(request: Request, clientAddress?: string) {
  return requestEvent(Object.assign(request, { context: { clientAddress } }))
}

async function statuses(requests: Array<() => Promise<Response>>): Promise<number[]> {
  const result: number[] = []
  for (const send of requests) result.push((await send()).status)
  return result
}

describe("Auth rate limiting", () => {
  afterEach(() => {
    resetAuth()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("turns the limiter on in a Worker build without NODE_ENV", async () => {
    workerRuntime()
    const auth = createAuthForRequest(definition, signIn())
    expect((await auth.$context).rateLimit.enabled).toBe(true)
  })

  it("keeps the limiter off on a development server", async () => {
    vi.stubGlobal("__VITEHUB_AUTH_DEV__", true)
    vi.stubEnv("NODE_ENV", "production")
    const auth = createAuthForRequest(definition, signIn())
    expect((await auth.$context).rateLimit.enabled).toBe(false)
  })

  it("keeps an explicit rateLimit.enabled", async () => {
    workerRuntime()
    const auth = createAuthForRequest(defineAuth(() => ({ database: "memory" as const, rateLimit: { enabled: false }, secret })), signIn())
    expect((await auth.$context).rateLimit.enabled).toBe(false)
  })

  it("limits each cf-connecting-ip address in its own bucket", async () => {
    workerRuntime()
    const first = nextAddress()
    const second = nextAddress()
    const send = (address: string) => () => handleAuthRequest(definition, cloudflareRequest(address))

    expect(await statuses([send(first), send(first), send(first), send(first)])).toEqual([401, 401, 401, 429])
    // Another client still signs in: the first address did not fill a shared bucket.
    expect(await statuses([send(second)])).toEqual([401])
  })

  it("reads the Standard Context client address of the event", async () => {
    workerRuntime()
    const first = nextAddress()
    const second = nextAddress()
    const send = (address: string) => () => {
      const request = signIn()
      return handleAuthRequest(definition, standardEvent(request, address))
    }

    expect(await statuses([send(first), send(first), send(first), send(first)])).toEqual([401, 401, 401, 429])
    expect(await statuses([send(second)])).toEqual([401])
  })

  it("limits manual Web Request hosts by the supplied peer address", async () => {
    workerRuntime()
    const handler = createAuthHandler(definition)
    const first = nextAddress()
    const second = nextAddress()
    const send = (clientAddress: string, index: number) => () => handler(signIn({
      "x-forwarded-for": `203.0.113.${index}`,
      "x-vitehub-client-address": `203.0.113.${index}`,
    }), { clientAddress })

    expect(await statuses([send(first, 1), send(first, 2), send(first, 3), send(first, 4)])).toEqual([401, 401, 401, 429])
    expect(await statuses([send(second, 5)])).toEqual([401])
  })

  it("ignores client-sent X-Forwarded-For and client address headers", async () => {
    workerRuntime()
    const address = nextAddress()
    const send = (index: number) => () => handleAuthRequest(definition, cloudflareRequest(address, {
      "x-forwarded-for": `203.0.113.${index}`,
      "x-vitehub-client-address": `203.0.113.${index}`,
    }))

    expect(await statuses([send(1), send(2), send(3), send(4)])).toEqual([401, 401, 401, 429])
  })

  it("records the host address on a session and drops a client-sent one", async () => {
    workerRuntime()
    const address = nextAddress()
    const signUp = (email: string, headers: Record<string, string>) => new Request("https://app.example.com/api/auth/sign-up/email", {
      body: JSON.stringify({ email, name: "Ada", password: "correct-horse-battery" }),
      headers: { "content-type": "application/json", origin: "https://app.example.com", ...headers },
      method: "POST",
    })
    const auth = createAuthForRequest(definition, signIn())
    const context = await auth.$context
    const ipOf = async (token: string) => (await context.internalAdapter.findSession(token))?.session.ipAddress ?? null

    const viaHandler = signUp("handler@example.com", { "cf-connecting-ip": address, "x-vitehub-client-address": "203.0.113.50" })
    Object.defineProperty(viaHandler, "ip", { get: () => viaHandler.headers.get("cf-connecting-ip") })
    const response = await handleAuthRequest(definition, viaHandler)
    const { token } = await response.json() as { token: string }
    expect(await ipOf(token)).toBe(address)

    const manualHandler = createAuthHandler(definition)
    const manualResponse = await manualHandler(signUp("manual@example.com", { "x-vitehub-client-address": "203.0.113.52" }), { clientAddress: address })
    expect(manualResponse.status).toBe(200)
    const manualSession = await manualResponse.json() as { token: string }
    expect(await ipOf(manualSession.token)).toBe(address)

    const viaApi = await auth.api.signUpEmail({
      body: { email: "api@example.com", name: "Ada", password: "correct-horse-battery" },
      headers: { "x-vitehub-client-address": "203.0.113.51" },
    })
    // Better Auth falls back to 127.0.0.1 in tests when it finds no address.
    expect(await ipOf(viaApi.token!)).not.toBe("203.0.113.51")
  })

  it("stores the counters in the app Database with authDatabase()", () => {
    const options = createBetterAuthOptions(defineAuth(() => ({ database: authDatabase(), secret })))
    expect(options.rateLimit?.storage).toBe("database")
  })

  it("keeps an explicit storage and a secondary storage", () => {
    expect(createBetterAuthOptions(defineAuth(() => ({ database: authDatabase(), rateLimit: { storage: "memory" }, secret }))).rateLimit?.storage).toBe("memory")
    const store: SecondaryStorage = { delete: async () => {}, get: async () => null, getAndDelete: async () => null, increment: async () => 1, set: async () => {} }
    // Better Auth keeps the counters in a secondary storage by default.
    expect(createBetterAuthOptions(defineAuth(() => ({ database: authDatabase(), secondaryStorage: store, secret }))).rateLimit?.storage).toBeUndefined()
  })

  it("reads only the host address unless the app trusts proxy headers", () => {
    expect(createBetterAuthOptions(definition).advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-vitehub-client-address"])
    expect(createBetterAuthOptions(defineAuth(() => ({ advanced: { trustedProxyHeaders: true }, secret }))).advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-forwarded-for", "x-vitehub-client-address"])
    expect(createBetterAuthOptions(defineAuth(() => ({ advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } }, secret }))).advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-real-ip"])
  })
})
