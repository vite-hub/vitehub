import { afterEach, expect, it, vi } from "vitest"
import { Readable } from "node:stream"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"

import { requestConsole } from "../src/console/runtime/client/request.ts"

// The playground is outside this package's TypeScript project, so load its real module at test time.
const { callConsoleFixture } = await vi.importActual<{
  callConsoleFixture: (origin: string, payload: unknown, cookie?: string) => Promise<unknown>
}>("../../../playground/console/rpc.ts")

afterEach(() => {
  vi.unstubAllGlobals()
})

it("loads Console data through the playground's stateless RPC endpoint", async () => {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/_vitehub/rpc/__call") {
      return Response.json(await callConsoleFixture("http://localhost:5173", JSON.parse(String(init?.body))))
    }
    return Response.json({ sections: ["agents"] })
  })
  vi.stubGlobal("fetch", fetch)

  await expect(requestConsole("/api/_vitehub/console/sections"))
    .resolves.toEqual({ sections: ["agents"] })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenLastCalledWith(new URL("http://localhost:5173/api/_vitehub/console/sections"), {
    body: undefined,
    headers: { "content-type": "application/json" },
    method: "GET",
  })
})

it("serves Auth analytics, cursor filters and explicit disabled-event data", async () => {
  const { authFixture } = await vi.importActual<{ authFixture: (input: unknown, enabled?: boolean) => unknown }>("../../../playground/console/auth-fixture.ts")
  expect(authFixture({ operation: "overview" })).toMatchObject({ users: 1048, analytics: { days: expect.any(Array) }, recent: { enabled: true } })
  const first = authFixture({ operation: "activity", activity: { group: "sign-in", limit: 2 } }) as { events: Array<{ id: string }>; nextCursor: string }
  const next = authFixture({ operation: "activity", activity: { group: "sign-in", limit: 2, cursor: first.nextCursor } }) as { events: Array<{ id: string }> }
  expect(first.events).toHaveLength(2)
  expect(next.events).toHaveLength(2)
  expect(new Set([...first.events, ...next.events].map(event => event.id)).size).toBe(4)
  expect(authFixture({ operation: "describe" }, false)).toMatchObject({ events: { enabled: false }, pages: expect.arrayContaining(["overview", "activity"]) })
  expect(authFixture({ operation: "overview" }, false)).toMatchObject({ users: 1048, analytics: null, recent: { enabled: false, events: [] } })
  expect(authFixture({ operation: "activity" }, false)).toEqual({ enabled: false, events: [] })
})

async function playgroundRequest(endpoint: string, input?: unknown, status = 200): Promise<unknown> {
  const { consoleMockAPI } = await vi.importActual<{ consoleMockAPI: () => Plugin }>("../../../playground/console/mock-api.ts")
  type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>
  let handler: Middleware | undefined
  // SAFETY: The playground hook only registers middleware with this server fixture.
  const configure = consoleMockAPI().configureServer as (server: { middlewares: { use: (middleware: Middleware) => void } }) => void
  configure({ middlewares: { use: middleware => { handler = middleware } } })
  // SAFETY: The route reads only the method, URL, and body stream from this fixture.
  const request = Readable.from(input === undefined ? [] : [JSON.stringify(input)]) as IncomingMessage
  request.method = input === undefined ? "GET" : "POST"
  request.url = endpoint
  let text = ""
  const response = { statusCode: 200, setHeader: vi.fn(), end: (value: string) => { text = value } }
  if (!handler) throw new Error("Expected playground middleware")
  // SAFETY: The route writes only the status, headers, and response body.
  await handler(request, response as unknown as ServerResponse, () => { throw new Error("Unexpected next middleware") })
  expect(response.statusCode).toBe(status)
  return JSON.parse(text)
}

it("paginates Blob fixtures when the Console omits a limit", async () => {
  const first = await playgroundRequest("/api/_vitehub/console/blob")
  expect(first).toMatchObject({ hasMore: true, cursor: "3", limit: 3, blobs: expect.any(Array) })
  expect(first).toHaveProperty("blobs.length", 3)
  const next = await playgroundRequest("/api/_vitehub/console/blob?cursor=3")
  expect(next).toMatchObject({ hasMore: false, blobs: [
    expect.objectContaining({ pathname: "exports/usage-september.csv" }),
    expect.objectContaining({ pathname: "invoices/inv_2026_09.pdf" }),
  ] })
  expect(next).not.toHaveProperty("cursor")
  const filtered = await playgroundRequest("/api/_vitehub/console/blob?prefix=screenshots/")
  expect(filtered).toMatchObject({ hasMore: false })
  expect(filtered).toHaveProperty("blobs.length", 2)
})

it("runs a manual Schedule Definition and lists it as runnable", async () => {
  await expect(playgroundRequest("/api/_vitehub/console/schedule-run", { name: "nightly-digest" }))
    .resolves.toMatchObject({ run: { scheduleId: "nightly-digest", status: "succeeded" } })
  const history = await playgroundRequest("/api/_vitehub/console/definitions?section=schedules")
  expect(history).toMatchObject({ records: [
    expect.objectContaining({ id: "definition:nightly-digest", runnable: true }),
  ] })
})

it("rejects unknown Agents without changing the Agent catalog or invocation history", async () => {
  const agents = await playgroundRequest("/api/_vitehub/console/agents")
  const invocations = await playgroundRequest("/api/_vitehub/console/invocations")
  await expect(playgroundRequest("/api/_vitehub/console/agents/unknown/invocations", { prompt: "Hello" }, 404))
    .resolves.toEqual({ error: "Agent invocation is not available." })
  expect(await playgroundRequest("/api/_vitehub/console/agents")).toEqual(agents)
  expect(await playgroundRequest("/api/_vitehub/console/invocations")).toEqual(invocations)
})

it("creates distinct IDs for simultaneous new chats", async () => {
  const endpoint = "/api/_vitehub/console/agents/interface-engineer/invocations"
  const [first, second] = await Promise.all([
    playgroundRequest(endpoint, { prompt: "First" }),
    playgroundRequest(endpoint, { prompt: "Second" }),
  ])
  expect(first).toMatchObject({ id: expect.any(String) })
  expect(second).toMatchObject({ id: expect.any(String) })
  expect((first as { id: string }).id).not.toBe((second as { id: string }).id)
})

it.each(["reindex-console", "sched_console_reindex", "unknown-schedule"])("rejects non-runnable Schedule %j", async (name) => {
  await expect(playgroundRequest("/api/_vitehub/console/schedule-run", { name }, 404))
    .resolves.toEqual({ message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation." })
})

it.each([null, {}, { name: "" }, { name: 42 }])("rejects invalid Schedule payload %j", async (input) => {
  await expect(playgroundRequest("/api/_vitehub/console/schedule-run", input, 400))
    .resolves.toEqual({ message: "Schedule run requires a Schedule Definition name." })
})

it.each(["", "Inspect this screenshot"])("preserves images in a new chat with prompt %j", async (prompt) => {
  const file = { url: "data:image/png;base64,aW1hZ2U=", filename: "screenshot.png" }
  const created = await playgroundRequest("/api/_vitehub/console/agents/interface-engineer/invocations", { prompt, files: [file] })
  expect(created).toMatchObject({ id: expect.any(String) })
  // SAFETY: The assertion above verifies the response ID before it is used in a route.
  const { id } = created as { id: string }
  const detail = await playgroundRequest(`/api/_vitehub/console/invocations/${id}`)
  expect(detail).toMatchObject({
    invocation: { status: "running", title: prompt || file.filename },
    observations: expect.arrayContaining([expect.objectContaining({
      name: "agent.invocation.start",
      attributes: expect.objectContaining({
        "input.hasPrompt": Boolean(prompt),
        "input.hasMessages": true,
        "input.messages": [{ id: "user-1", role: "user", parts: [
          ...(prompt ? [{ type: "text", text: prompt }] : []),
          { type: "image", url: file.url, name: file.filename, mediaType: "image/png", size: 5 },
        ] }],
      }),
    })]),
  })
})

it("preserves selected invoker profiles in new chats", async () => {
  const created = await playgroundRequest("/api/_vitehub/console/agents/product-reviewer/invocations", { prompt: "Review this", invokerProfileId: "reviewer" })
  const { id } = created as { id: string }
  const detail = await playgroundRequest(`/api/_vitehub/console/invocations/${id}`)
  expect(detail).toMatchObject({ observations: expect.arrayContaining([expect.objectContaining({
    name: "agent.invocation.start",
    attributes: expect.objectContaining({ "input.invokerProfileId": "reviewer" }),
  })]) })
  await expect(playgroundRequest("/api/_vitehub/console/agents/product-reviewer/invocations", { prompt: "Review this", invokerProfileId: "unknown" }, 400))
    .resolves.toEqual({ error: "Unknown Agent invocation profile." })
})

it("rejects empty and malformed image chats", async () => {
  const endpoint = "/api/_vitehub/console/agents/interface-engineer/invocations"
  await expect(playgroundRequest(endpoint, { prompt: "  ", files: [] }, 400))
    .resolves.toMatchObject({ error: "A prompt or image is required." })
  await expect(playgroundRequest(endpoint, { files: [{ url: "not-an-image" }] }, 400))
    .resolves.toMatchObject({ error: expect.any(String) })
})

it.each([
  [401, "CONSOLE_SIGN_IN_REQUIRED"],
  [403, "CONSOLE_ACCESS_DENIED"],
  [404, "CONSOLE_NOT_FOUND"],
  [500, "CONSOLE_REQUEST_FAILED"],
])("answers a failed %i fixture with the code the server gives it", async (status, code) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Playground failure", { status })))
  await expect(callConsoleFixture("http://localhost:5173", { operation: "env.get", input: {} }))
    .resolves.toMatchObject({ code, fix: expect.any(String), message: "Playground failure", ok: false, status })
})

it("forwards failure cookies while translating write operations to fixture requests", async () => {
  const fetch = vi.fn(async () => new Response("Playground failure", { status: 503 }))
  vi.stubGlobal("fetch", fetch)

  await expect(callConsoleFixture("http://localhost:5173", {
    operation: "invocations.cancel",
    input: { id: "run/1" },
  }, "playground-fail=invocations:503")).resolves.toMatchObject({
    code: "CONSOLE_UNAVAILABLE", message: "Playground failure", ok: false, status: 503,
  })
  expect(fetch).toHaveBeenCalledWith(new URL("http://localhost:5173/api/_vitehub/console/invocations/run%2F1"), {
    body: JSON.stringify({ action: "cancel" }),
    headers: { "content-type": "application/json", cookie: "playground-fail=invocations:503" },
    method: "POST",
  })
})

it("serves the MCP client from a stateful fixture, with sign-in, Run as, and the shared session", async () => {
  const origin = "http://localhost:5173"
  type Answer = { ok: boolean, value: Record<string, unknown> & { connections?: Array<Record<string, unknown>> } }
  const call = async (operation: string, input: Record<string, unknown> = {}, cookie?: string) => await callConsoleFixture(origin, { input, operation }, cookie) as Answer
  const overview = await call("mcp-client.list")
  expect(overview.value.sharedSession).toBe(false)
  expect(overview.value.servers).toEqual([
    { authorizationServer: `${origin}/api/auth`, label: "Northwind Ledger", url: `${origin}/mcp` },
    { auth: "console", label: "ViteHub MCP", url: `${origin}/_vitehub/mcp` },
  ])
  expect(overview.value.connections?.map(connection => [connection.label, connection.auth, connection.status])).toEqual([
    ["Maxi García", "oauth", "connected"],
    ["Lucía Romero", "oauth", "connected"],
    ["Lucía (API key)", "bearer", "connected"],
    ["Sam Rivera", "oauth", "signed-out"],
    ["You", "console", "connected"],
    ["docs.example.com/mcp", "none", "connected"],
  ])
  expect((await call("mcp-client.list", {}, "playground-mcp=shared")).value.sharedSession).toBe(true)

  // Run as: the same call through two accounts sees different private accounts.
  const finances = async (id: string) => JSON.stringify((await call("mcp-client.call", { arguments: { scope: "household" }, id, tool: "get_finances" })).value.result)
  expect(await finances("mcp_maxi")).toContain("Maxi savings")
  expect(await finances("mcp_lucia")).toContain("Lucía card")
  expect(await finances("mcp_lucia")).not.toContain("Maxi savings")
  expect((await call("mcp-client.items", { id: "mcp_sam", kind: "tools" })).ok).toBe(false)

  // Sign in as someone else: the fixture sends the browser to the callback page, which finishes the sign-in.
  const started = await call("mcp-client.connect", { prompt: "login", server: "/mcp" })
  const callback = new URL(String(started.value.authorizationUrl))
  expect(callback.pathname).toBe("/_vitehub/mcp-client/callback")
  const completed = await call("mcp-client.complete", { code: "playground", state: callback.searchParams.get("state") })
  expect(completed.value).toMatchObject({ label: "Sam Rivera", status: "connected" })
  await call("mcp-client.disconnect", { id: completed.value.id })
  expect((await call("mcp-client.list")).value.connections).toHaveLength(6)
})
