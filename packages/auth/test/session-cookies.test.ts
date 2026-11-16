import { defineHandler, HTTPError } from "h3"
import { memoryAdapter } from "better-auth/adapters/memory"
import { getStandardContext, installStandardContext } from "@vite-hub/runtime/internal/h3"
import { Response as UndiciResponse } from "undici"
import { afterEach, describe, expect, it } from "vitest"

import {
  createAuthAccessHandler,
  getAuthForDefinition,
  handleAuthRequest,
  requireAuth,
  resetAuth,
  withAnonymousAuthorization,
  withAuth,
  withAuthorization,
} from "../src/internal/server.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

import type { H3Event } from "h3"
import type { ViteHubContext } from "@vite-hub/runtime"
import type { AuthDefinition } from "../src/index.ts"

const origin = "http://localhost:3000"
const day = 24 * 60 * 60 * 1000

interface MemoryRow { [key: string]: unknown }

afterEach(() => {
  resetAuth()
})

function createStoredAuth(session?: { cookieCache: { enabled: boolean, maxAge: number } }) {
  const db: Record<string, MemoryRow[]> = { account: [], session: [], user: [], verification: [] }
  const definition = defineFixedAuth({
    access: { routes: ["/private"] },
    emailAndPassword: { enabled: true },
    database: memoryAdapter(db),
    secret: "vitehub-session-cookies-test-secret-3d9e1a7c5b",
    ...session ? { session } : {},
  })
  return { db, definition }
}

function withoutCookie(cookie: string, name: string): string {
  return cookie.split("; ").filter(pair => !pair.startsWith(`${name}=`)).join("; ")
}

async function signUp(definition: AuthDefinition): Promise<string> {
  const response = await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).filter(pair => !pair?.endsWith("=")).join("; ")
}

/** Makes the stored session two days old: past the default `updateAge` of one day, five days before it ends. */
function ageSession(db: Record<string, MemoryRow[]>): Date {
  const expiresAt = new Date(Date.now() + 5 * day)
  db.session![0]!.expiresAt = expiresAt
  return expiresAt
}

function endSession(db: Record<string, MemoryRow[]>): void {
  db.session![0]!.expiresAt = new Date(Date.now() - 1000)
}

function storedExpiry(db: Record<string, MemoryRow[]>): number {
  return new Date(db.session![0]!.expiresAt as Date).getTime()
}

/** The `Set-Cookie` values that renew the session token for the default `expiresIn` of seven days. */
function renewals(headers: Headers): string[] {
  return headers.getSetCookie().filter(cookie => /^better-auth\.session_token=[^;]+;/.test(cookie) && /Max-Age=604800/i.test(cookie))
}

function cookieCaches(headers: Headers): string[] {
  return headers.getSetCookie().filter(cookie => /^better-auth\.session_data=[^;]+;/.test(cookie))
}

function deletions(headers: Headers): string[] {
  return headers.getSetCookie().filter(cookie => cookie.startsWith("better-auth.session_token=;") && /Max-Age=0/i.test(cookie))
}

type EventHandler = (event: H3Event & ViteHubContext) => unknown

/** A real H3 2 handler with Standard Context, as the ViteHub Nitro plugin sets it. */
function serve(handler: EventHandler) {
  const app = defineHandler(async (event) => {
    installStandardContext(event)
    return handler(event)
  })
  return (cookie: string, init: RequestInit = {}) => app.fetch(new Request(`${origin}/private`, {
    ...init,
    headers: { accept: "application/json", cookie, ...init.headers },
  }))
}

function fetchRequest(cookie: string): Request {
  return new Request(`${origin}/private`, { headers: { accept: "application/json", cookie } })
}

describe("session cookies of guarded requests", () => {
  it("renews the browser session of a withAuthorization() route on an H3 event", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    const before = ageSession(db)
    const fetchEvent = serve(withAuthorization(true, () => ({ ok: true }), definition))

    const response = await fetchEvent(cookie)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(storedExpiry(db)).toBeGreaterThan(before.getTime() + day)
    expect(renewals(response.headers)).toHaveLength(1)
    expect(response.headers.get("cache-control")).toBe("private")
  })

  it("renews the browser session of a Fetchable route", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    ageSession(db)
    const route = { fetch: withAuthorization(true, () => Response.json({ ok: true }), definition) }

    const response = await route.fetch(fetchRequest(cookie))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(renewals(response.headers)).toHaveLength(1)
    expect(response.headers.get("cache-control")).toBe("private")
  })

  it("renews once for a Fetchable route that Nitro calls with the Request of an H3 event", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    ageSession(db)
    const route = { fetch: withAuth(() => new Response("ok"), definition) }
    const fetchEvent = serve(event => route.fetch(event.req))

    const response = await fetchEvent(cookie)

    expect(response.status).toBe(200)
    expect(renewals(response.headers)).toHaveLength(1)
  })

  it("sends the renewed cookie with an error that the handler throws", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    ageSession(db)
    const fetchEvent = serve(withAuth(() => {
      throw new HTTPError({ status: 409, message: "Conflict." })
    }, definition))

    const response = await fetchEvent(cookie)

    expect(response.status).toBe(409)
    expect(renewals(response.headers)).toHaveLength(1)
  })

  it("deletes the cookies of an ended session with the 401", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    endSession(db)
    const guard = withAuth(() => new Response("ok"), definition)

    const fetched = await guard(fetchRequest(cookie))
    expect(fetched.status).toBe(401)
    expect(deletions(fetched.headers)).toHaveLength(1)

    const served = await serve(guard)(cookie)
    expect(served.status).toBe(401)
    expect(deletions(served.headers)).toHaveLength(1)
  })

  it("makes a public Response private and keeps a private or no-store one", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    const cacheControls = ["public, max-age=300, s-maxage=600", "no-cache", "no-store", "private, max-age=60"]
    const answers: Record<string, string | null> = {}

    for (const cacheControl of cacheControls) {
      const guard = withAuthorization(true, () => new Response("file", { headers: { "cache-control": cacheControl } }), definition)
      ageSession(db)
      const fetched = await guard(fetchRequest(cookie))
      ageSession(db)
      const served = await serve(guard)(cookie)
      expect(renewals(fetched.headers)).toHaveLength(1)
      expect(renewals(served.headers)).toHaveLength(1)
      expect(served.headers.get("cache-control")).toBe(fetched.headers.get("cache-control"))
      answers[cacheControl] = fetched.headers.get("cache-control")
    }

    expect(answers).toEqual({
      "public, max-age=300, s-maxage=600": "private, max-age=300",
      "no-cache": "private, no-cache",
      "no-store": "no-store",
      "private, max-age=60": "private, max-age=60",
    })
  })

  it("renews the browser session in access middleware and inline guards on an H3 event", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    const access = createAuthAccessHandler([{ route: "/private" }], definition)

    ageSession(db)
    const middleware = await serve(async event => await access(event) ?? { ok: true })(cookie)
    expect(middleware.status).toBe(200)
    expect(renewals(middleware.headers)).toHaveLength(1)
    // Middleware cannot see the response of the route, so it asks for the strictest policy.
    expect(middleware.headers.get("cache-control")).toBe("no-store")

    ageSession(db)
    const inline = await serve(async (event) => {
      const { user } = await requireAuth(event, definition)
      return { id: user.id }
    })(cookie)
    expect(inline.status).toBe(200)
    expect(renewals(inline.headers)).toHaveLength(1)

    ageSession(db)
    const both = await serve(async event => await access(event) ?? withAuth(() => new Response("ok"), definition)(event))(cookie)
    expect(both.status).toBe(200)
    expect(renewals(both.headers)).toHaveLength(1)

    ageSession(db)
    // Like a Blob serve route with `authorize`: it drops the Cache-Control that middleware set and returns its own.
    const blob = await serve(async event => await access(event) ?? withAuthorization(true, () => {
      getStandardContext(event).res.headers?.delete("cache-control")
      return new Response("file", { headers: { "cache-control": "public, max-age=300" } })
    }, definition)(event))(cookie)
    expect(renewals(blob.headers)).toHaveLength(1)
    expect(blob.headers.get("cache-control")).toBe("private, max-age=300")
  })

  it("moves the cookies of an inline guard to the Response of a Fetchable guard", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    ageSession(db)
    const route = {
      fetch: withAuth(async (request: Request) => {
        await requireAuth(request, definition)
        return new Response("ok")
      }, definition),
    }
    const request = fetchRequest(cookie)

    const response = await route.fetch(request)

    expect(response.status).toBe(200)
    expect(renewals(response.headers)).toHaveLength(1)
    expect(response.headers.get("cache-control")).toBe("private")
    // The cookies moved, so a host that also copies `res.headers` does not send them twice.
    expect(getStandardContext(request).res.headers?.getSetCookie()).toEqual([])
    expect(getStandardContext(request).res.headers?.has("cache-control")).toBe(false)
  })

  it("keeps the no-store of a route behind access middleware", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    const access = createAuthAccessHandler([{ route: "/private" }], definition)
    const noStore = () => new Response("secret", { headers: { "cache-control": "no-store" } })

    ageSession(db)
    const guarded = await serve(async event => await access(event) ?? withAuth(noStore, definition)(event))(cookie)
    expect(renewals(guarded.headers)).toHaveLength(1)
    expect(guarded.headers.get("cache-control")).toBe("no-store")

    ageSession(db)
    const plain = await serve(async event => await access(event) ?? noStore())(cookie)
    expect(renewals(plain.headers)).toHaveLength(1)
    expect(plain.headers.get("cache-control")).toBe("no-store")

    ageSession(db)
    const request = fetchRequest(cookie)
    expect(await access(request)).toBeUndefined()
    const fetched = await withAuth(noStore, definition)(request)
    expect(renewals(fetched.headers)).toHaveLength(1)
    expect(fetched.headers.get("cache-control")).toBe("no-store")
  })

  it("sends the cookies with a Response of another Fetch implementation", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    ageSession(db)
    const route = withAuth(() => new UndiciResponse("file", { headers: { "cache-control": "public, max-age=60" } }), definition)

    const response = await route(fetchRequest(cookie))

    expect(renewals(response.headers)).toHaveLength(1)
    expect(response.headers.get("cache-control")).toBe("private, max-age=60")
    expect(await response.text()).toBe("file")
  })

  it("sends the cookies when an authorize callback throws", async () => {
    const deny = () => {
      throw new HTTPError({ status: 403, message: "Denied." })
    }
    // Better Auth deletes an ended session from the database, so each request gets its own.
    async function signedIn() {
      const { db, definition } = createStoredAuth()
      return { cookie: await signUp(definition), db, definition }
    }

    const ended = await signedIn()
    endSession(ended.db)
    const anonymous = await serve(withAnonymousAuthorization(deny, () => ({ ok: true }), ended.definition))(ended.cookie)
    expect(anonymous.status).toBe(403)
    expect(deletions(anonymous.headers)).toHaveLength(1)

    const aged = await signedIn()
    ageSession(aged.db)
    const authorized = await serve(withAuthorization(deny, () => ({ ok: true }), aged.definition))(aged.cookie)
    expect(authorized.status).toBe(403)
    expect(renewals(authorized.headers)).toHaveLength(1)

    // A plain Fetch host gets the error, so the cookies stay in `res.headers` of the Standard Context.
    const fetched = await signedIn()
    endSession(fetched.db)
    const request = fetchRequest(fetched.cookie)
    await expect(withAnonymousAuthorization(deny, () => new Response("ok"), fetched.definition)(request)).rejects.toThrow("Denied.")
    expect(deletions(getStandardContext(request).res.headers ?? new Headers())).toHaveLength(1)
  })

  it("sends each cookie once when the route sets it too", async () => {
    const { db, definition } = createStoredAuth({ cookieCache: { enabled: true, maxAge: 300 } })
    // Without the cookie cache, each read of the session goes to the database and sets `session_data` again.
    const cookie = withoutCookie(await signUp(definition), "better-auth.session_data")
    const auth = getAuthForDefinition(definition)
    // Like the Console account route: it reads the session itself and sends the cookies of its own read.
    const route = withAuthorization(true, async (input: Request | H3Event) => {
      const request = input instanceof Request ? input : input.req
      const { headers } = await auth.api.getSession({ headers: request.headers, returnHeaders: true })
      const response = new Response("ok")
      for (const value of headers.getSetCookie()) response.headers.append("set-cookie", value)
      return response
    }, definition)

    ageSession(db)
    const served = await serve(route)(cookie)
    expect(cookieCaches(served.headers)).toHaveLength(1)
    expect(renewals(served.headers)).toHaveLength(1)

    ageSession(db)
    const fetched = await route(fetchRequest(cookie))
    expect(cookieCaches(fetched.headers)).toHaveLength(1)
    expect(renewals(fetched.headers)).toHaveLength(1)
  })

  it("sends each cookie once when an error Response copies the prepared headers", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    const access = createAuthAccessHandler([{ route: "/private" }], definition)
    // Like a Blob serve route: H3 drops the middleware headers of an error Response, so the route copies them.
    const notFound = withAuthorization(true, (event: H3Event) => new Response("Blob not found.", {
      headers: new Headers(getStandardContext(event).res.headers),
      status: 404,
    }), definition)

    ageSession(db)
    const response = await serve(async event => await access(event) ?? notFound(event))(cookie)

    expect(response.status).toBe(404)
    expect(renewals(response.headers)).toHaveLength(1)
  })

  it("puts the renewed cookie in the Standard Context of a plain Request when access middleware allows it", async () => {
    const { db, definition } = createStoredAuth()
    const cookie = await signUp(definition)
    ageSession(db)
    const request = fetchRequest(cookie)

    await expect(createAuthAccessHandler([{ route: "/private" }], definition)(request)).resolves.toBeUndefined()

    const { headers } = getStandardContext(request).res
    expect(renewals(headers ?? new Headers())).toHaveLength(1)
    expect(headers?.get("cache-control")).toBe("no-store")
  })
})
