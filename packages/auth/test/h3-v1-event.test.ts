import { createServer } from "node:http"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuthAccessHandler, handleAuthRequest, resetAuth, toAuthRequest, withAuth } from "../src/server.ts"

import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { AuthNodeRequestEvent } from "../src/index.ts"

/** The H3 1 event shape that Nitro 2 passes to Nuxt 4 server handlers: an own `node` field and a `req` getter on the prototype. */
class H3V1Event {
  readonly __is_event__ = true
  readonly context: Record<string, unknown> = {}
  readonly node: { req: IncomingMessage & { originalUrl?: string }, res: ServerResponse }

  constructor(req: IncomingMessage, res: ServerResponse) {
    this.node = { req, res }
  }

  get req(): IncomingMessage {
    return this.node.req
  }
}

type EventHandler = (event: H3V1Event & AuthNodeRequestEvent) => Promise<Response | unknown>

const servers: Server[] = []

afterEach(async () => {
  resetAuth()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

/** Serve one handler like Nitro 2: H3 1 removes the app base path from `req.url` and keeps the full path in `originalUrl`. */
async function serve(handler: EventHandler, base = "/"): Promise<string> {
  const server = createServer(async (req: IncomingMessage & { originalUrl?: string }, res) => {
    req.originalUrl = req.url
    const mount = base.replace(/\/$/, "")
    if (mount && req.url?.startsWith(`${mount}/`)) req.url = req.url.slice(mount.length)
    try {
      const result = await handler(new H3V1Event(req, res) as H3V1Event & AuthNodeRequestEvent)
      const response = result instanceof Response ? result : Response.json(result ?? null)
      res.statusCode = response.status
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") res.setHeader(key, value)
      })
      if (response.headers.getSetCookie().length) res.setHeader("set-cookie", response.headers.getSetCookie())
      res.end(Buffer.from(await response.arrayBuffer()))
    }
    catch (error) {
      res.statusCode = 500
      res.end(String(error))
    }
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function createDefinition() {
  const db: Record<string, unknown[]> = { account: [], session: [], user: [], verification: [] }
  return defineAuth({
    access: { routes: ["/private/**"] },
    appName: "ViteHub",
    emailAndPassword: { enabled: true },
    runtime: { database: memoryAdapter(db), secret: "abcdefghijklmnopqrstuvwxyz0123456789" },
  })
}

describe("H3 1 server events", () => {
  it("signs a user in through Auth routes, withAuth, and access middleware", async () => {
    const definition = createDefinition()
    const access = createAuthAccessHandler([{ route: "/private/**" }], definition)
    const guarded = withAuth((_event, authorization) => ({ email: authorization.user.email }), definition)
    const origin = await serve(async (event) => {
      const pathname = new URL(event.node.req.url ?? "/", "http://localhost").pathname
      if (pathname.startsWith("/api/auth/")) return handleAuthRequest(definition, event)
      if (pathname.startsWith("/private/")) return await access(event) ?? Response.json({ private: true })
      return guarded(event)
    })
    const headers = { "content-type": "application/json", origin }
    const credentials = { email: "h3-v1@example.com", password: "passwordpassword" }

    const signUp = await fetch(`${origin}/api/auth/sign-up/email`, { body: JSON.stringify({ ...credentials, name: "H3 1" }), headers, method: "POST" })
    expect(signUp.status).toBe(200)
    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, { body: JSON.stringify(credentials), headers, method: "POST" })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")

    expect(await (await fetch(`${origin}/api/auth/get-session`, { headers: { cookie } })).json()).toMatchObject({ user: { email: credentials.email } })
    expect(await (await fetch(`${origin}/api/data`, { headers: { cookie } })).json()).toEqual({ email: credentials.email })
    expect((await fetch(`${origin}/api/data`)).status).toBe(401)
    expect(await (await fetch(`${origin}/private/page`, { headers: { cookie } })).json()).toEqual({ private: true })
    expect((await fetch(`${origin}/private/page`)).status).toBe(401)
  })

  it("keeps the app base path that H3 1 removes from the request URL", async () => {
    let url: string | undefined
    const origin = await serve(async (event) => {
      url = toAuthRequest(event).url
      return Response.json({ path: event.node.req.url })
    }, "/app/")

    expect(await (await fetch(`${origin}/app/api/auth/get-session?x=1`)).json()).toEqual({ path: "/api/auth/get-session?x=1" })
    expect(url).toBe(`${origin}/app/api/auth/get-session?x=1`)
  })

  it("reads a request body that the host already read", async () => {
    const definition = createDefinition()
    const origin = await serve(async (event) => {
      const chunks: Buffer[] = []
      for await (const chunk of event.node.req) chunks.push(chunk as Buffer)
      Object.assign(event.node.req, { body: Buffer.concat(chunks).toString("utf8") })
      return handleAuthRequest(definition, event)
    })

    const response = await fetch(`${origin}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: "read@example.com", name: "Read", password: "passwordpassword" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ user: { email: "read@example.com" } })
  })
})
