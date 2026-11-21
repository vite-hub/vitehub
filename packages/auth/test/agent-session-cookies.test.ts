import { defineHandler } from "h3"
import { defineAgent } from "@vite-hub/agent"
import { chat } from "@vite-hub/agent/capabilities"
import { createAgentWebhookRequest, createChannelChatRouteHandler } from "@vite-hub/agent/server/internal"
import { getStandardContext, installStandardContext } from "@vite-hub/runtime/internal/h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import definition from "#vitehub/auth/definition"
import { authenticated } from "../src/agent.ts"
import { handleAuthRequest, resetAuth } from "../src/internal/server.ts"

const stored = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }))

// `authenticated()` reads the session through the discovered Auth Definition.
vi.mock("#vitehub/auth/definition", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory")
  const { defineFixedAuth } = await import("./fixed-auth.ts")
  return {
    default: defineFixedAuth({
      emailAndPassword: { enabled: true },
      database: memoryAdapter(stored.db),
      secret: "vitehub-agent-session-cookies-secret-8c2f4e6a1d",
    }),
  }
})

const origin = "http://localhost:3000"
const chatBody = JSON.stringify({ id: "chat-1", messages: [{ id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" }] })

afterEach(() => {
  resetAuth()
})

async function signUpAndEndSession(): Promise<string> {
  Object.assign(stored.db, { account: [], session: [], user: [], verification: [] })
  const response = await handleAuthRequest(definition!, new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  stored.db.session![0]!.expiresAt = new Date(Date.now() - 1000)
  return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).filter(pair => !pair?.endsWith("=")).join("; ")
}

function deletions(headers: Headers): string[] {
  return headers.getSetCookie().filter(cookie => cookie.startsWith("better-auth.session_token=;") && /Max-Age=0/i.test(cookie))
}

function chatRoute() {
  return createChannelChatRouteHandler(defineAgent({
    capabilities: [chat()],
    driver: { run: () => (async function* () {})() },
    invoker: authenticated(),
    runtime: false,
  }) as never)
}

function chatRequest(cookie: string): Request {
  return new Request(`${origin}/_vitehub/agents/support/chat`, {
    body: chatBody,
    headers: { "content-type": "application/json", cookie },
    method: "POST",
  })
}

describe("session cookies of the Agent chat route", () => {
  it("deletes the cookies of an ended session with the 401 of an H3 chat request", async () => {
    const cookie = await signUpAndEndSession()
    const route = chatRoute()
    // Like the generated Nitro route: the Fetchable copies the Request of the event before the chat handler reads it.
    const app = defineHandler((event) => {
      installStandardContext(event)
      const { headers, method, signal, url } = event.req
      return route(createAgentWebhookRequest({ body: event.req.body ?? undefined, from: event.req, headers, method, signal, url }), { agentName: "support", event: event.req } as never)
    })

    const response = await app.fetch(chatRequest(cookie))

    expect(response.status).toBe(401)
    expect(deletions(response.headers)).toHaveLength(1)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("deletes the cookies of an ended session with the 401 of a chat request on a plain Fetch host", async () => {
    const cookie = await signUpAndEndSession()
    const request = chatRequest(cookie)

    const response = await chatRoute()(request, { agentName: "support" } as never)

    expect(response.status).toBe(401)
    expect(deletions(response.headers)).toHaveLength(1)
    // The headers moved, so a host that also copies `res.headers` does not send them twice.
    expect(getStandardContext(request).res.headers?.getSetCookie()).toEqual([])
  })
})
