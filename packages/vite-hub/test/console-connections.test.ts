import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Plugin } from "vite"

import { readConsoleSessionUser } from "../src/console/auth.ts"
import { consoleConnectionsActorId, writeConsoleConnectionsActor } from "../src/console/auth-build.ts"
import {
  canSendConnectionKey,
  connectionApprovalsSchema,
  connectionApprovalCountsSchema,
  connectionConnectURL,
  connectionListSchema,
  connectionNextStep,
  loadConnectionApprovals,
  requestConnectionsManagement,
} from "../src/console/runtime/client/connections-management.ts"
import { ConsoleRequestError } from "../src/console/runtime/client/request.ts"
import type { ConsoleSectionId } from "../src/console/runtime/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { vitehub } from "../src/index.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

const connection = {
  account: { email: "ada@example.com", id: "1" },
  actions: [{ highRisk: true, id: "gmail.users.messages.send", method: "POST", write: true }],
  connectedAt: "2026-09-29T08:00:00.000Z",
  credential: "oauth2",
  name: "gmail",
  provider: "google",
  scopes: { declared: ["a", "b"], granted: ["a"], missing: ["b"] },
  status: "connected",
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Connections management client", () => {
  it("posts one JSON action with same-origin credentials and validates the response", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ connections: [connection] }))
    vi.stubGlobal("fetch", fetch)

    await expect(requestConnectionsManagement("/app/_vitehub/connections", "list", connectionListSchema))
      .resolves.toEqual({ connections: [connection] })
    expect(fetch).toHaveBeenCalledWith("/app/_vitehub/connections", {
      body: JSON.stringify({ action: "list" }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  })

  it("retains older pending decisions when the newest 100 approvals are decided", async () => {
    const base = { action: "gmail.users.messages.modify", actor: "agent:mail", createdAt: "2026-09-29T08:00:00.000Z", name: "gmail" }
    const pending = { ...base, id: "old-pending", status: "pending" }
    vi.stubGlobal("fetch", vi.fn(async (_endpoint, init: RequestInit) => {
      const input = JSON.parse(String(init.body)) as { status?: string }
      return Response.json({ approvals: input.status === "pending" ? [pending] : Array.from({ length: 100 }, (_, index) => ({ ...base, id: `new-${index}`, status: "executed" })) })
    }))
    const result = await loadConnectionApprovals("/_vitehub/connections", "gmail")
    expect(result.history).toHaveLength(100)
    expect(result.pending).toEqual([pending])
  })

  it("requests an older bounded pending page using the returned cursor", async () => {
    const base = { action: "gmail.users.messages.modify", actor: "agent:mail", createdAt: "2026-09-29T08:00:00.000Z", name: "gmail", status: "pending" }
    const fetch = vi.fn(async (_endpoint, init: RequestInit) => {
      const input = JSON.parse(String(init.body)) as { before?: string, status?: string }
      if (!input.status) return Response.json({ approvals: [] })
      return Response.json(input.before
        ? { approvals: [{ ...base, id: "old-pending" }] }
        : { approvals: Array.from({ length: 100 }, (_, index) => ({ ...base, id: `pending-${index}` })), nextCursor: "pending-99" })
    })
    vi.stubGlobal("fetch", fetch)
    const first = await loadConnectionApprovals("/_vitehub/connections", "gmail")
    expect(first.pending).toHaveLength(100)
    expect(first.nextCursor).toBe("pending-99")
    const second = await loadConnectionApprovals("/_vitehub/connections", "gmail", first.nextCursor)
    expect(second.pending).toEqual([{ ...base, id: "old-pending" }])
    expect(second.nextCursor).toBeUndefined()
    expect(fetch).toHaveBeenCalledWith("/_vitehub/connections", expect.objectContaining({
      body: JSON.stringify({ name: "gmail", status: "pending", before: "pending-99", action: "approval-summaries" }),
    }))
  })

  it("validates grouped approval counts without requiring approval rows", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ counts: { gmail: 205 } }))
    vi.stubGlobal("fetch", fetch)
    expect(await requestConnectionsManagement("/_vitehub/connections", "approval-counts", connectionApprovalCountsSchema)).toEqual({ counts: { gmail: 205 } })
    expect(fetch).toHaveBeenCalledWith("/_vitehub/connections", expect.objectContaining({ body: JSON.stringify({ action: "approval-counts" }) }))
  })

  it("does not keep approval inputs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      approvals: [{ action: "gmail.users.messages.send", actor: "agent:mail", createdAt: "2026-09-29T08:00:00.000Z", id: "a1", input: { to: "team@example.com" }, name: "gmail", status: "pending" }],
    })))

    const result = await requestConnectionsManagement("/_vitehub/connections", "approvals", connectionApprovalsSchema, { name: "gmail", status: "pending" })
    expect(result.approvals[0]).not.toHaveProperty("input")
    expect(result.approvals[0]).toMatchObject({ actor: "agent:mail", id: "a1", status: "pending" })
  })

  it("keeps the code, why, fix, and docs of a management error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: {
        code: "CONNECTION_FORBIDDEN",
        docs: "https://vitehub.dev/docs/connections/server-api#management-routes",
        fix: "Sign in again.",
        message: "The management route found no signed-in manager for this request.",
      },
    }, { status: 403 })))

    const error = await requestConnectionsManagement("/_vitehub/connections", "list", connectionListSchema).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ConsoleRequestError)
    expect(error).toMatchObject({
      code: "CONNECTION_FORBIDDEN",
      docs: "https://vitehub.dev/docs/connections/server-api#management-routes",
      fix: "Sign in again.",
      message: "The management route found no signed-in manager for this request.",
      status: 403,
    })
  })

  it.each([
    [401, "text/plain", "Sign in first.", "CONSOLE_SIGN_IN_REQUIRED", "Sign in first."],
    [403, "text/html", "<html>denied</html>", "CONSOLE_ACCESS_DENIED", "The Console access policy rejected this account."],
    [404, "text/html", "<html>Not found</html>", "CONSOLE_CONNECTIONS_MANAGEMENT_UNAVAILABLE", "The Connections management route is not mounted."],
    [500, "text/plain", "upstream", "CONSOLE_REQUEST_FAILED", "upstream"],
  ])("uses the Console code for a %i response without a JSON error", async (status, type, body, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": type }, status })))

    const error = await requestConnectionsManagement("/_vitehub/connections", "list", connectionListSchema).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code, message, status, fix: expect.any(String), docs: expect.stringMatching(/^https:\/\/vitehub\.dev\/docs\//) })
  })

  it("ignores a docs link that is not HTTPS", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "CONNECTION_PROVIDER", docs: "javascript:alert(1)", message: "Provider \"google\" rejected the call." } }, { status: 502 })))
    const error = await requestConnectionsManagement("/_vitehub/connections", "approve", connectionListSchema, { id: "a1" }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: "CONNECTION_PROVIDER", docs: undefined, message: "Provider \"google\" rejected the call.", status: 502 })
  })

  it("rejects responses that do not match the schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ connections: [{ ...connection, status: "unknown" }] })))
    await expect(requestConnectionsManagement("/_vitehub/connections", "list", connectionListSchema)).rejects.toThrow()
  })

  it("requires the credential kind of each Connection", async () => {
    const { credential: _credential, ...withoutCredential } = connection
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ connections: [withoutCredential] })))
    await expect(requestConnectionsManagement("/_vitehub/connections", "list", connectionListSchema)).rejects.toThrow()
  })

  it.each([
    [{ hostname: "console.example.com", protocol: "https:" }, true],
    [{ hostname: "localhost", protocol: "http:" }, true],
    [{ hostname: "app.localhost", protocol: "http:" }, true],
    [{ hostname: "127.0.0.1", protocol: "http:" }, true],
    [{ hostname: "[::1]", protocol: "http:" }, true],
    [{ hostname: "console.example.com", protocol: "http:" }, false],
    [{ hostname: "10.0.0.5", protocol: "http:" }, false],
  ])("sends API keys only over HTTPS or to a loopback host (%o)", (location, expected) => {
    expect(canSendConnectionKey(location)).toBe(expected)
  })

  it("builds the connect URL under the management base", () => {
    expect(connectionConnectURL("/_vitehub/connections", "gmail")).toBe("/_vitehub/connections/connect/gmail")
    expect(connectionConnectURL("/app/_vitehub/connections/", "team.mail")).toBe("/app/_vitehub/connections/connect/team.mail")
    expect(connectionConnectURL("/_vitehub/connections", "a b")).toBe("/_vitehub/connections/connect/a%20b")
    expect(connectionConnectURL("/app/_vitehub/connections", "gmail", "/app/_vitehub/connections"))
      .toBe("/app/_vitehub/connections/connect/gmail?return=%2Fapp%2F_vitehub%2Fconnections")
  })

  it.each([
    ["oauth2", "disconnected", [], { kind: "connect", label: "Connect" }],
    ["oauth2", "revoked", [], { kind: "connect", label: "Connect" }],
    ["oauth2", "reauth_required", [], { kind: "connect", label: "Reconnect" }],
    ["oauth2", "connected", ["mail.send"], { kind: "connect", label: "Reconnect" }],
    ["oauth2", "connected", [], undefined],
    ["api-key", "disconnected", [], { kind: "key", label: "Set key" }],
    ["api-key", "revoked", [], { kind: "key", label: "Set key" }],
    ["api-key", "reauth_required", [], { kind: "key", label: "Replace key" }],
    ["api-key", "connected", [], undefined],
  ] as const)("names the next step of a %s Connection that is %s (missing %o)", (credential, status, missing, expected) => {
    expect(connectionNextStep({ credential, scopes: { declared: [], granted: [], missing: [...missing] }, status })).toEqual(expected)
  })
})

describe("Console session user", () => {
  it("reads the signed-in user with every user field", async () => {
    const getSession = vi.fn().mockResolvedValue({ session: { id: "s1" }, user: { email: "ada@example.com", id: "u1" } })
    const request = new Request("http://localhost/_vitehub/connections", { headers: { cookie: "vitehub_console.session_token=t" } })

    await expect(readConsoleSessionUser({ api: { getSession } }, request)).resolves.toEqual({ email: "ada@example.com", id: "u1" })
    expect(getSession).toHaveBeenCalledWith({ headers: request.headers })
  })

  it("returns undefined without a session and propagates lookup errors", async () => {
    const request = new Request("http://localhost/_vitehub/connections")
    await expect(readConsoleSessionUser({ api: { getSession: async () => null } }, request)).resolves.toBeUndefined()
    await expect(readConsoleSessionUser({ api: { getSession: async () => ({ user: { id: "" } }) } }, request)).resolves.toBeUndefined()
    await expect(readConsoleSessionUser({ api: { getSession: async () => { throw new Error("database down") } } }, request)).rejects.toThrow("database down")
  })

  it("writes one actor module that checks the installed Console access policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-actor-"))
    try {
      // The Connections handler calls the policy with the Request first and the server event second.
      // The access policy reads the signed-in user, so one module serves every Console access mode.
      const file = await writeConsoleConnectionsActor(root)
      expect(file).toBe(join(root, ".vitehub/nitro/console/connections-actor.mjs"))
      const actor = await readFile(file, "utf8")
      expect(actor).toContain('import { consoleConnectionsActor } from "vite-hub/console/sections"')
      expect(actor).toContain("viteHubConsoleConnectionsActor(_request, event)")
      expect(actor).toContain("return consoleConnectionsActor(event)")
      expect(actor).not.toContain("user:open")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    { command: "serve" as const, connections: true, enabled: true },
    { command: "build" as const, connections: true, enabled: false },
    { command: "build" as const, connections: { management: true }, enabled: true },
  ])("advertises Connections only with a mounted handler ($command, $enabled)", async ({ command, connections, enabled }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-sections-"))
    try {
      const plugin = consoleVitePlugin({
        console: command === "serve" ? { auth: false } : { auth: false, authorize: hostManagedAuthorize },
        connections,
        sections: ["env", "connections"],
      })
      const hook = plugin.config
      if (!hook) throw new TypeError("Expected Console config hook.")
      await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [{ root }, { command, mode: command === "serve" ? "development" : "production" }])
      const generated = await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated.includes('"connections"')).toBe(enabled)
      expect(generated).toContain('"env"')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    { console: { auth: false } as const, handler: 'import actor from "#vitehub/console/connections-actor"' },
    { console: false as const, handler: 'actor: "development"' },
  ])("checks development Connections routes with the Console actor module (console: $console)", async ({ console, handler }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-dev-"))
    try {
      // SAFETY: vitehub() returns a flat list of concrete plugins in these integration tests.
      const plugins = vitehub({ connections: true, console, database: true, preset: "node" }) as Plugin[]
      const connections = plugins.find(plugin => plugin.name === "@vite-hub/connections/vite")
      const hook = connections?.config
      if (!hook) throw new TypeError("Expected the Connections config hook.")
      const config: { nitro: { handlers?: Array<{ handler: string }> }, root: string, [VITEHUB_NITRO_CONFIG_CONTEXT]: true } = { nitro: {}, root, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }
      await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [config, { command: "serve", mode: "development" }])
      const generated = await readFile(config.nitro.handlers![0]!.handler, "utf8")
      expect(generated).toContain(handler)
      expect(generated).not.toContain("user:local")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("aliases the actor module only when the Connections section is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-alias-"))
    try {
      const configure = async (sections: ConsoleSectionId[]) => {
        const plugin = consoleVitePlugin({ console: { auth: false }, sections })
        const config: { root: string, nitro?: { alias?: Record<string, string> } } = { root }
        const hook = plugin.config
        if (!hook) throw new TypeError("Expected Console config hook.")
        await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [config, { command: "serve", mode: "development" }])
        return config.nitro?.alias?.[consoleConnectionsActorId]
      }
      const actor = await configure(["connections"])
      expect(actor).toBe(join(root, ".vitehub/nitro/console/connections-actor.mjs"))
      expect(await readFile(actor!, "utf8")).toContain("return consoleConnectionsActor(event)")
      expect(await configure(["env"])).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
