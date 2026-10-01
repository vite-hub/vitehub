import { execFileSync } from "node:child_process"

import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"

import { validateAgentCapabilityComposition } from "../src/capability-runtime.ts"
import { gmail } from "../src/capabilities.ts"
import { createAgentInspectionMetadata, defineAgent, runAgent } from "../src/index.ts"

import type { AgentCapabilityDefinition, AgentToolSet } from "../src/types.ts"

type Call = { input: Record<string, unknown>, method: string, signal?: AbortSignal }
type Handler = (method: string, input: Record<string, unknown>) => unknown

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function fakeConnections(handler: Handler) {
  const calls: Call[] = []
  const uses: Array<{ name: string, options: unknown }> = []
  const method = (name: string) => vi.fn(async (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    calls.push({ input, method: name, ...(options?.signal ? { signal: options.signal } : {}) })
    return await handler(name, input)
  })
  const primitive = {
    use: vi.fn((name: string, options: unknown) => {
      uses.push({ name, options })
      return {
        gmail: {
          users: {
            drafts: { create: method("drafts.create") },
            labels: { list: method("labels.list") },
            messages: { attachments: { get: method("messages.attachments.get") }, get: method("messages.get"), list: method("messages.list"), modify: method("messages.modify") },
          },
        },
      }
    }),
  }
  return { calls, primitive, uses }
}

function contextStore(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] }
}

async function capabilityTools(capability: AgentCapabilityDefinition, handler: Handler, values: Record<string, unknown> = { "agent.invocation.traceId": "inv_1", "agent.name": "inbox" }) {
  if (typeof capability.tools !== "function") throw new Error("gmail capability must expose a tool resolver")
  const connections = fakeConnections(handler)
  const tools = await capability.tools({ capabilities: { connections: connections.primitive }, context: contextStore(values) } as never) as AgentToolSet
  return { ...connections, tools }
}

function connectionError(code: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { code, ...fields })
}

describe("gmail capability", () => {
  it("exposes the selected tools and requires the connections primitive", async () => {
    const read = gmail({ connection: "google" })
    expect(read).toMatchObject({
      id: "gmail",
      metadata: { connection: "google", tools: ["read", "search"] },
      mode: "read",
      requires: [{ primitive: "connections" }],
    })
    expect(read.workspace).toBeUndefined()
    expect(Object.keys((await capabilityTools(read, () => ({}))).tools).sort()).toEqual(["gmail_read", "gmail_search"])

    const all = gmail({ connection: "google", tools: ["draft", "labels", "modify", "read", "search"] })
    expect(all).toMatchObject({ mode: "write" })
    expect(Object.keys((await capabilityTools(all, () => ({}))).tools).sort())
      .toEqual(["gmail_draft", "gmail_labels", "gmail_modify", "gmail_read", "gmail_search"])
    expect(gmail({ connection: "google", tools: ["labels"] })).toMatchObject({ mode: "read" })

    expect(() => gmail({} as never)).toThrow("requires a Connection name")
    expect(() => gmail({ connection: "   " })).toThrow("requires a Connection name")
    expect(() => gmail({ connection: "google", tools: [] })).toThrow("gmail({ tools })")
    expect(() => gmail({ connection: "google", tools: ["send" as never] })).toThrow("gmail({ tools })")
    await expect(Promise.resolve().then(() => (read.tools as (context: never) => unknown)({ capabilities: {} } as never)))
      .rejects.toThrow("requires the connections primitive")
  })

  it("does not need a Workspace or provider Driver and lists its tools in inspection", () => {
    const capability = gmail({ connection: "google", tools: ["search", "modify"] })
    expect(() => validateAgentCapabilityComposition([capability], { driverKind: "model", hasWorkspace: false })).not.toThrow()
    const inspected = createAgentInspectionMetadata(defineAgent({ capabilities: [capability], driver: "codex", workspace: { mode: "read" } }))
    expect(inspected.tools).toContainEqual(expect.objectContaining({
      commands: ["gmail_modify", "gmail_search"],
      description: "Use Gmail through the google Connection.",
      name: "gmail",
    }))
  })

  it("calls the Connection as the Agent actor with the invocation id and abort signal", async () => {
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["labels"] }), () => ({ labels: [{ id: "Label_1", name: "Receipts", type: "user" }] }))
    const controller = new AbortController()
    await expect(runtime.tools.gmail_labels!.execute?.({}, { abortSignal: controller.signal } as never)).resolves.toEqual({
      labels: [{ id: "Label_1", name: "Receipts", type: "user" }],
      status: "ok",
    })
    expect(runtime.uses).toEqual([{ name: "google", options: { actor: "agent:inbox", invocationId: "inv_1" } }])
    expect(runtime.calls).toEqual([{ input: { userId: "me" }, method: "labels.list", signal: controller.signal }])
  })

  it("preserves the definition name when runAgent has no host identity", async () => {
    const connections = fakeConnections(() => ({ labels: [] }))
    const agent = defineAgent({
      name: "inbox",
      capabilities: [gmail({ connection: "google", tools: ["labels"] })],
      driver: { run: async context => await context.tools?.gmail_labels?.execute?.({}) },
    })
    const result = await runAgent(agent, { capabilities: { connections: connections.primitive }, memo: (_key, create) => create(), runtime: "unknown", waitUntil: () => {} }, {})
    expect(result).toMatchObject({ status: "ok" })
    expect(connections.uses).toEqual([expect.objectContaining({ options: expect.objectContaining({ actor: "agent:inbox" }) })])
  })

  it("retrieves external text parts and preserves the abort signal", async () => {
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["read"] }), (method) => method === "messages.get"
      ? { id: "m1", payload: { mimeType: "text/plain", body: { attachmentId: "a1" } } }
      : { data: base64Url("External body") })
    const controller = new AbortController()
    await expect(runtime.tools.gmail_read!.execute?.({ id: "m1" }, { abortSignal: controller.signal } as never)).resolves.toMatchObject({ message: { body: "External body" } })
    expect(runtime.calls.at(-1)).toEqual({ method: "messages.attachments.get", input: { id: "a1", messageId: "m1", userId: "me" }, signal: controller.signal })
  })

  it.each([
    { filename: "notes.txt" },
    { headers: [{ name: "Content-Disposition", value: "attachment; filename=notes.txt" }] },
  ])("selects the HTML body instead of a text attachment, %j", async (attachment) => {
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["read"] }), () => ({
      id: "m1",
      payload: { mimeType: "multipart/mixed", parts: [
        { ...attachment, mimeType: "text/plain", body: { attachmentId: "a1", data: base64Url("Attached file") } },
        { mimeType: "text/html", body: { data: base64Url("<p>Email body</p>") } },
      ] },
    }))
    await expect(runtime.tools.gmail_read!.execute?.({ id: "m1" })).resolves.toMatchObject({ message: { body: "Email body" } })
    expect(runtime.calls).toHaveLength(1)
  })

  it.each(["team/google", "équipe/google", "a b"])("uses the discovered Connection name %s", async (name) => {
    const runtime = await capabilityTools(gmail({ connection: name, tools: ["labels"] }), () => ({ labels: [] }))
    await runtime.tools.gmail_labels!.execute?.({})
    expect(runtime.uses[0]?.name).toBe(name)
  })

  it.each(["text/plain", "text/html"])("decodes the declared MIME charset for %s", async (mimeType) => {
    const body = mimeType === "text/html" ? "<p>Résumé</p>" : "Résumé"
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["read"] }), () => ({
      id: "m1", payload: { mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; charset=\"iso-8859-1\"` }], body: { data: Buffer.from(body, "latin1").toString("base64url") } },
    }))
    await expect(runtime.tools.gmail_read!.execute?.({ id: "m1" })).resolves.toMatchObject({ message: { body: "Résumé" } })
  })

  it("falls back to UTF-8 when the MIME charset is unsupported", async () => {
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["read"] }), () => ({
      id: "m1", payload: { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=not-a-real-charset" }], body: { data: base64Url("Résumé") } },
    }))
    await expect(runtime.tools.gmail_read!.execute?.({ id: "m1" })).resolves.toMatchObject({ message: { body: "Résumé" } })
  })

  it("folds long Unicode draft subjects into valid encoded words", async () => {
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["draft"] }), () => ({ id: "d1" }))
    const subject = "Résumé 🚀".repeat(20)
    await runtime.tools.gmail_draft!.execute?.({ body: "body", subject, to: ["a@example.com"] })
    const message = (runtime.calls[0]!.input.requestBody as { message: { raw: string } }).message
    const mime = Buffer.from(message.raw, "base64url").toString("utf8")
    const header = mime.match(/Subject: ([\s\S]*?)\r\nMIME-Version:/)![1]!
    const words = header.split(/\r\n /)
    expect(words.length).toBeGreaterThan(1)
    expect(words.every(word => word.length <= 75)).toBe(true)
    expect(words.map(word => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("")).toBe(subject)
  })

  it("searches with message metadata", async () => {
    const runtime = await capabilityTools(gmail({ connection: "google" }), (method, input) => method === "messages.list"
      ? { messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "next" }
      : {
          id: input.id,
          labelIds: ["INBOX"],
          payload: { headers: [{ name: "From", value: "a@example.com" }, { name: "subject", value: `Hello ${String(input.id)}` }] },
          snippet: "Hi",
          threadId: "t1",
        })

    const result = await runtime.tools.gmail_search!.execute?.({ max: 2, query: "is:unread" })
    expect(result).toEqual({
      messages: [
        { date: undefined, from: "a@example.com", id: "m1", labelIds: ["INBOX"], snippet: "Hi", subject: "Hello m1", threadId: "t1", to: undefined },
        { date: undefined, from: "a@example.com", id: "m2", labelIds: ["INBOX"], snippet: "Hi", subject: "Hello m2", threadId: "t1", to: undefined },
      ],
      nextPageToken: "next",
      status: "ok",
    })
    expect(runtime.calls[0]).toEqual({ input: { maxResults: 2, q: "is:unread", userId: "me" }, method: "messages.list" })
    expect(runtime.calls[1]).toEqual({ input: { format: "metadata", id: "m1", metadataHeaders: ["Date", "From", "Subject", "To"], userId: "me" }, method: "messages.get" })

    await runtime.tools.gmail_search!.execute?.({})
    expect(runtime.calls.at(-3)).toMatchObject({ input: { maxResults: 10, q: "in:inbox" } })
    await expect(runtime.tools.gmail_search!.execute?.({ max: 51 })).rejects.toThrow("max must be an integer from 1 to 50")
  })

  it("reads the plain-text body, falls back to HTML, and truncates", async () => {
    const plain = { payload: { mimeType: "multipart/alternative", parts: [
      { body: { data: base64Url("<p>HTML</p>") }, mimeType: "text/html" },
      { body: { data: base64Url("Olá, plain body") }, mimeType: "text/plain" },
    ] } }
    const html = { payload: { body: { data: base64Url("<style>x{}</style><p>Line &amp; one</p><br>two") }, mimeType: "text/html" } }
    const runtime = await capabilityTools(gmail({ connection: "google" }), (_method, input) => ({ id: input.id, ...(input.id === "html" ? html : plain) }))

    await expect(runtime.tools.gmail_read!.execute?.({ id: "plain" })).resolves.toMatchObject({
      message: { body: "Olá, plain body", id: "plain", truncated: false },
      status: "ok",
    })
    expect(runtime.calls[0]).toEqual({ input: { format: "full", id: "plain", userId: "me" }, method: "messages.get" })
    await expect(runtime.tools.gmail_read!.execute?.({ id: "html" })).resolves.toMatchObject({ message: { body: "Line & one\n\ntwo" } })
    await expect(runtime.tools.gmail_read!.execute?.({ id: "plain", maxChars: 3 })).resolves.toMatchObject({ message: { body: "Olá", truncated: true } })
    await expect(runtime.tools.gmail_read!.execute?.({ id: "../x" })).rejects.toThrow("must be a Gmail message id")
  })

  it("modifies labels with validated ids", async () => {
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["modify"] }), () => ({ id: "m1", labelIds: ["Label_1"] }))
    await expect(runtime.tools.gmail_modify!.execute?.({ addLabelIds: ["Label_1"], id: "m1", removeLabelIds: ["INBOX"] })).resolves.toEqual({
      message: { id: "m1", labelIds: ["Label_1"] },
      status: "ok",
    })
    expect(runtime.calls).toEqual([{ input: { id: "m1", requestBody: { addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"] }, userId: "me" }, method: "messages.modify" }])
    await expect(runtime.tools.gmail_modify!.execute?.({ id: "m1" })).rejects.toThrow("requires addLabelIds or removeLabelIds")
    await expect(runtime.tools.gmail_modify!.execute?.({ addLabelIds: ["a b"], id: "m1" })).rejects.toThrow("Gmail label ids")
  })

  it("creates drafts as RFC 2822 messages and rejects header injection", async () => {
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["draft"] }), () => ({ id: "d1", message: { id: "m1", threadId: "t1" } }))
    await expect(runtime.tools.gmail_draft!.execute?.({
      bcc: ["hidden@example.com"],
      body: "Hello\nÜber",
      subject: "Café",
      to: ["person@example.com"],
    })).resolves.toEqual({ draft: { id: "d1", messageId: "m1", threadId: "t1" }, status: "ok" })

    const raw = (runtime.calls[0]!.input.requestBody as { message: { raw: string } }).message.raw
    const message = Buffer.from(raw, "base64url").toString("utf8")
    const [headers, body] = message.split("\r\n\r\n")
    expect(headers!.split("\r\n")).toEqual([
      "To: person@example.com",
      "Bcc: hidden@example.com",
      `Subject: =?UTF-8?B?${Buffer.from("Café").toString("base64")}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ])
    expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hello\nÜber")

    await expect(runtime.tools.gmail_draft!.execute?.({ body: "x", subject: "Hi\r\nBcc: evil@example.com", to: ["a@example.com"] }))
      .rejects.toThrow("subject must be one line")
    await expect(runtime.tools.gmail_draft!.execute?.({ body: "x", subject: "Hi", to: ["a@example.com, evil@example.com"] }))
      .rejects.toThrow("valid email address")
    await expect(runtime.tools.gmail_draft!.execute?.({ body: "x", subject: "Hi", to: [] }))
      .rejects.toThrow("at least one email address")
    expect(runtime.calls).toHaveLength(1)
  })

  it("returns Connection failures as tool results", async () => {
    const failures: Record<string, Error> = {
      m1: connectionError("CONNECTION_APPROVAL_REQUIRED", { requestId: "approval_1" }),
      m2: connectionError("CONNECTION_REAUTH_REQUIRED"),
      m3: connectionError("CONNECTION_DENIED"),
      m4: connectionError("CONNECTION_PROVIDER", { status: 404 }),
      m5: new Error("network down"),
    }
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["modify"] }), (_method, input) => {
      throw failures[input.id as string]
    })
    const modify = (id: string) => runtime.tools.gmail_modify!.execute?.({ addLabelIds: ["Label_1"], id })

    await expect(modify("m1")).resolves.toMatchObject({ approvalId: "approval_1", message: expect.stringContaining("vitehub connections approvals approve approval_1"), status: "approval_required" })
    await expect(modify("m2")).resolves.toMatchObject({ connection: "google", message: expect.stringContaining("vitehub connections connect 'google'"), status: "reauth_required" })
    await expect(modify("m3")).resolves.toMatchObject({ status: "denied" })
    await expect(modify("m4")).resolves.toMatchObject({ httpStatus: 404, status: "provider_error" })
    await expect(modify("m5")).rejects.toThrow("network down")
  })

  it.each(["team/a b", "team/a'b", "team/$(printf injected)"])("quotes reauthorization for %s as one shell argument", async (connection) => {
    const runtime = await capabilityTools(gmail({ connection, tools: ["labels"] }), () => { throw connectionError("CONNECTION_REAUTH_REQUIRED") })
    const result = await runtime.tools.gmail_labels!.execute?.({})
    const parsed = v.parse(v.object({ message: v.string(), status: v.literal("reauth_required") }), result)
    const argument = parsed.message.match(/`vitehub connections connect (.*?)`/)?.[1]
    expect(argument).toBeDefined()
    const output = execFileSync("bash", ["-c", `set -- ${argument}; printf '%s\\n' "$#" "$1"`], { encoding: "utf8" })
    expect(output).toBe(`1\n${connection}\n`)
  })

  it("uses a generic Agent actor when the Agent name is unknown", async () => {
    const runtime = await capabilityTools(gmail({ connection: "google", tools: ["labels"] }), () => ({}), {})
    await runtime.tools.gmail_labels!.execute?.({})
    expect(runtime.uses).toEqual([{ name: "google", options: { actor: "agent:agent" } }])
  })
})
