import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleSessionActor } from "../src/console/auth.ts"
import { consoleConnectionsActorId, writeConsoleConnectionsActor } from "../src/console/auth-build.ts"
import {
  connectionApprovalsSchema,
  connectionApprovalCountsSchema,
  connectionConnectURL,
  connectionListSchema,
  loadConnectionApprovals,
  requestConnectionsManagement,
} from "../src/console/runtime/client/connections-management.ts"
import { ConsoleRequestError } from "../src/console/runtime/client/request.ts"
import type { ConsoleSectionId } from "../src/console/runtime/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

const connection = {
  account: { email: "ada@example.com", id: "1" },
  actions: [{ highRisk: true, id: "gmail.users.messages.send", method: "POST", write: true }],
  connectedAt: "2026-09-29T08:00:00.000Z",
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

  it.each([
    [401, "Sign in to manage Connections."],
    [403, "You do not have access to this operation."],
    [404, "Connections management is not available. Production builds need connections: { management: true }."],
  ])("maps status %i to a fixed message", async (status, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "X", message: "server text" } }, { status })))

    const error = await requestConnectionsManagement("/_vitehub/connections", "list", connectionListSchema).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ConsoleRequestError)
    expect(error).toMatchObject({ status, message })
  })

  it("shows the server message for other failures and a generic message without one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "CONNECTION_PROVIDER", message: "Provider \"google\" rejected the call." } }, { status: 502 })))
    await expect(requestConnectionsManagement("/_vitehub/connections", "approve", connectionListSchema, { id: "a1" }))
      .rejects.toMatchObject({ status: 502, message: "Provider \"google\" rejected the call." })

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream", { status: 500 })))
    await expect(requestConnectionsManagement("/_vitehub/connections", "list", connectionListSchema))
      .rejects.toMatchObject({ status: 500, message: "Could not complete the request. Try again." })
  })

  it("rejects responses that do not match the schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ connections: [{ ...connection, status: "unknown" }] })))
    await expect(requestConnectionsManagement("/_vitehub/connections", "list", connectionListSchema)).rejects.toThrow()
  })

  it("builds the connect URL under the management base", () => {
    expect(connectionConnectURL("/_vitehub/connections", "gmail")).toBe("/_vitehub/connections/connect/gmail")
    expect(connectionConnectURL("/app/_vitehub/connections/", "team.mail")).toBe("/app/_vitehub/connections/connect/team.mail")
    expect(connectionConnectURL("/_vitehub/connections", "a b")).toBe("/_vitehub/connections/connect/a%20b")
  })
})

describe("Connections actor", () => {
  it("returns the signed-in user as user:<id>", async () => {
    const getSession = vi.fn().mockResolvedValue({ session: { id: "s1" }, user: { email: "ada@example.com", id: "u1" } })
    const request = new Request("http://localhost/_vitehub/connections", { headers: { cookie: "vitehub_console.session_token=t" } })

    await expect(consoleSessionActor({ api: { getSession } }, request)).resolves.toBe("user:u1")
    expect(getSession).toHaveBeenCalledWith({ headers: request.headers })
  })

  it("returns undefined without a session and propagates lookup errors", async () => {
    const request = new Request("http://localhost/_vitehub/connections")
    await expect(consoleSessionActor({ api: { getSession: async () => null } }, request)).resolves.toBeUndefined()
    await expect(consoleSessionActor({ api: { getSession: async () => ({ user: { id: "" } }) } }, request)).resolves.toBeUndefined()
    await expect(consoleSessionActor({ api: { getSession: async () => { throw new Error("database down") } } }, request)).rejects.toThrow("database down")
  })

  it("writes an actor module for each Console access mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-actor-"))
    try {
      const consoleAuth = await readFile(await writeConsoleConnectionsActor(root, "console-auth"), "utf8")
      expect(consoleAuth).toContain('import { createAuthForRequest } from "#vitehub/auth/server"')
      expect(consoleAuth).toContain('import { definition } from "./auth-definition.mjs"')
      expect(consoleAuth).toContain("consoleSessionActor(createAuthForRequest(definition, request), request)")

      const appAuth = await readFile(await writeConsoleConnectionsActor(root, "app-auth"), "utf8")
      expect(appAuth).toContain("consoleSessionActor(getAuthForRequest(request), request)")

      const file = await writeConsoleConnectionsActor(root, "none")
      expect(file).toBe(join(root, ".vitehub/nitro/console/connections-actor.mjs"))
      const none = (await import(file) as { default: () => unknown }).default
      expect(none()).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("aliases the actor module only when the Connections section is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-connections-alias-"))
    try {
      const configure = async (sections: ConsoleSectionId[]) => {
        const plugin = consoleVitePlugin({ console: true, sections })
        const config: { root: string, nitro?: { alias?: Record<string, string> } } = { root }
        const hook = plugin.config
        if (!hook) throw new TypeError("Expected Console config hook.")
        await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [config, { command: "serve", mode: "development" }])
        return config.nitro?.alias?.[consoleConnectionsActorId]
      }
      const actor = await configure(["connections"])
      expect(actor).toBe(join(root, ".vitehub/nitro/console/connections-actor.mjs"))
      expect(await readFile(actor!, "utf8")).toContain("return undefined")
      expect(await configure(["env"])).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
