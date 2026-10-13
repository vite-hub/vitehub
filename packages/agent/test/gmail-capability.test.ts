import { createAgentEnvIdentity } from "../src/internal/env-identity.ts"
import { describe, expect, it, vi } from "vitest"

import { validateAgentCapabilityComposition, workspaceRetirementPathsSymbol } from "../src/capability-runtime.ts"
import { gmail } from "../src/capabilities.ts"
import { createAgentInspectionMetadata, defineAgent } from "../src/index.ts"
import { agentInvocationTraceIdContextKey } from "../src/trace.ts"

import type { AgentCapabilityDefinition, AgentToolDefinition } from "../src/types.ts"

function base64Url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

function connections(options: { responses?: Record<string, (input: Record<string, unknown>) => unknown> } = {}) {
  const call = vi.fn(async (action: string, input: Record<string, unknown>, _options?: { signal?: AbortSignal }) => {
    const respond = options.responses?.[action]
    if (!respond) throw new Error(`Unexpected action ${action}`)
    return respond(input)
  })
  const runtime = {
    call,
    client: vi.fn((_name: string, _options: unknown) => ({ call, fetch: vi.fn() })),
  }
  return { primitive: { runtime: () => runtime }, runtime }
}

const event = { id: "event_1" }

function context(primitive: unknown) {
  return {
    agentIdentity: createAgentEnvIdentity({ name: "labeller" }),
    capabilities: { connections: primitive },
    context: new Map([[agentInvocationTraceIdContextKey, "trace_1"]]),
    event,
    run: { runId: "run_1" },
  }
}

async function tools(capability: AgentCapabilityDefinition, primitive: unknown, abortSignal?: AbortSignal): Promise<Record<string, AgentToolDefinition>> {
  if (typeof capability.tools !== "function") throw new Error("gmail capability must expose a tool resolver")
  // SAFETY: The Gmail tools read only the fields that the fake context sets.
  return await capability.tools({ ...context(primitive), abortSignal } as never) as Record<string, AgentToolDefinition>
}

async function run(tool: AgentToolDefinition | undefined, input: unknown): Promise<unknown> {
  if (!tool?.execute) throw new Error("expected an executable tool")
  // SAFETY: The Gmail tools do not read the execution options.
  return await tool.execute(input as never, {} as never)
}

const message = {
  id: "m1",
  labelIds: ["INBOX"],
  payload: {
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "To", value: "bob@example.com" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Mon, 28 Sep 2026 10:00:00 +0000" },
      { name: "X-Other", value: "ignored" },
    ],
    mimeType: "multipart/mixed",
    parts: [
      { body: { data: base64Url("Plain body ü") }, mimeType: "text/plain" },
      { body: { data: base64Url("<p>HTML body</p>") }, mimeType: "text/html" },
      { body: { attachmentId: "a1", size: 12 }, filename: "report.pdf", mimeType: "application/pdf" },
    ],
  },
  snippet: "Plain body",
  threadId: "t1",
}

describe("gmail capability", () => {
  it("declares both historical persisted Skill paths for safe migration", () => {
    const capability = gmail()
    expect((capability as unknown as Record<PropertyKey, unknown>)[workspaceRetirementPathsSymbol]).toEqual([
      ".agents/skills/gmail/SKILL.md",
      "skills/gmail/SKILL.md",
    ])
  })
  it.each(["execution", "context"])("forwards the %s cancellation signal to every Gmail request", async (source) => {
    const controller = new AbortController()
    const { primitive, runtime } = connections({ responses: {
      "gmail.users.messages.list": () => ({ messages: [{ id: "m1", threadId: "t1" }] }),
      "gmail.users.messages.get": () => message,
      "gmail.users.drafts.create": () => ({ id: "d1", message: { id: "m2", threadId: "t1" } }),
    } })
    const gmailTools = await tools(gmail({ operations: ["search", "read", "draft"] }), primitive, source === "context" ? controller.signal : undefined)
    for (const [name, input] of [
      ["gmail_search", {}],
      ["gmail_read", { id: "m1" }],
      ["gmail_draft", { body: "x", subject: "Hi", to: ["bob@example.com"] }],
    ] as const) {
      const tool = gmailTools[name]!
      await tool.execute!(input as never, { abortSignal: source === "execution" ? controller.signal : undefined } as never)
    }
    expect(runtime.call).toHaveBeenCalledTimes(4)
    for (const call of runtime.call.mock.calls) expect(call[2]).toMatchObject({ signal: controller.signal })
  })

  it("defines tools, requirements, and inspection from the enabled operations", async () => {
    const { primitive } = connections()
    const read = gmail()
    expect(read).toMatchObject({
      id: "gmail",
      metadata: { connection: "google", operations: ["search", "read"] },
      mode: "read",
      requires: [{ primitive: "connections" }],
    })
    expect(Object.keys(await tools(read, primitive)).sort()).toEqual(["gmail_read", "gmail_search"])

    const draft = gmail({ connection: "work-google", operations: ["search", "draft"] })
    expect(draft).toMatchObject({ metadata: { connection: "work-google", operations: ["search", "draft"] }, mode: "write" })
    const draftTools = await tools(draft, primitive)
    expect(Object.keys(draftTools).sort()).toEqual(["gmail_draft", "gmail_search"])
    expect(draftTools.gmail_draft?.metadata).toEqual({ connection: { name: "work-google", operation: "gmail.users.drafts.create" } })

    // Model Drivers can use Gmail because the Connection runs on the server.
    expect(() => validateAgentCapabilityComposition([draft], { driverKind: "model", hasWorkspace: false })).not.toThrow()
    const inspected = createAgentInspectionMetadata(defineAgent({ capabilities: [draft], driver: "codex", workspace: { mode: "write" } }))
    expect(inspected.tools).toContainEqual(expect.objectContaining({
      commands: ["gmail_search", "gmail_draft"],
      description: "Search, read, or draft Gmail messages through the \"work-google\" Connection.",
      name: "gmail",
    }))
  })

  it("rejects invalid options and a missing primitive", async () => {
    expect(() => gmail({ operations: ["send" as never] })).toThrow("gmail() requires")
    expect(() => gmail({ operations: [] })).toThrow("gmail() requires")
    expect(() => gmail({ connection: " " })).toThrow("gmail() requires")
    await expect(tools(gmail(), undefined)).rejects.toThrow("gmail() uses Connection \"google\", so it requires Connections")
    await expect(tools(gmail(), { runtime: "nope" })).rejects.toThrow("requires the connections primitive to expose runtime()")
    await expect(tools(gmail(), { runtime: () => ({}) })).rejects.toThrow("expose client()")
  })

  it("searches through the Connection with the Agent actor and invocation trace", async () => {
    const { primitive, runtime } = connections({
      responses: {
        "gmail.users.messages.get": input => ({ ...message, id: String(input.id) }),
        "gmail.users.messages.list": () => ({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "next" }),
      },
    })
    const result = await run((await tools(gmail(), primitive)).gmail_search, { max: 5, query: " from:alice " })
    expect(result).toEqual({
      messages: [{
        date: "Mon, 28 Sep 2026 10:00:00 +0000",
        from: "Alice <alice@example.com>",
        id: "m1",
        labelIds: ["INBOX"],
        snippet: "Plain body",
        subject: "Hello",
        threadId: "t1",
        to: "bob@example.com",
      }],
      nextPageToken: "next",
      query: "from:alice",
    })
    expect(runtime.call.mock.calls.map(([action, input]) => [action, input])).toEqual([
      ["gmail.users.messages.list", { userId: "me", maxResults: 5, q: "from:alice" }],
      ["gmail.users.messages.get", { userId: "me", format: "metadata", id: "m1", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] }],
    ])
    expect(runtime.client).toHaveBeenCalledWith("google", { access: expect.objectContaining({ actor: { id: "labeller", kind: "agent" }, invocationId: "trace_1" }), invocationId: "trace_1" })
    await expect(run((await tools(gmail(), primitive)).gmail_search, { max: 51 })).rejects.toThrow("from 1 to 50")
  })

  it("reads the text body, falls back to HTML, and truncates", async () => {
    const html = { ...message, payload: { ...message.payload, parts: [message.payload.parts[1]!] } }
    const { primitive } = connections({
      responses: { "gmail.users.messages.get": input => input.id === "html" ? html : message },
    })
    const readTools = await tools(gmail(), primitive)
    expect(await run(readTools.gmail_read, { id: "m1" })).toMatchObject({
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", size: 12 }],
      subject: "Hello",
      text: "Plain body ü",
      truncated: false,
    })
    expect(await run(readTools.gmail_read, { id: "html" })).toMatchObject({ text: "HTML body" })
    const long = { ...message, payload: { mimeType: "text/plain", body: { data: base64Url("x".repeat(600)) } } }
    const { primitive: longPrimitive } = connections({ responses: { "gmail.users.messages.get": () => long } })
    expect(await run((await tools(gmail(), longPrimitive)).gmail_read, { id: "m1", maxChars: 500 })).toMatchObject({ text: "x".repeat(500), truncated: true })
    await expect(run(readTools.gmail_read, { id: "a\nb" })).rejects.toThrow("one line")
  })

  it("fetches body parts that Gmail stores as attachments", async () => {
    const large = { ...message, payload: { mimeType: "multipart/alternative", parts: [{ body: { attachmentId: "body-1", size: 90_000 }, mimeType: "text/plain" }] } }
    const { primitive, runtime } = connections({
      responses: {
        "gmail.users.messages.attachments.get": () => ({ data: base64Url("Large plain body"), size: 16 }),
        "gmail.users.messages.get": () => large,
      },
    })
    const readTools = await tools(gmail(), primitive)
    expect(await run(readTools.gmail_read, { id: "m1" })).toMatchObject({ attachments: [], text: "Large plain body" })
    expect(runtime.call.mock.calls.map(([action, input]) => [action, input])).toEqual([
      ["gmail.users.messages.get", { userId: "me", format: "full", id: "m1" }],
      ["gmail.users.messages.attachments.get", { userId: "me", id: "body-1", messageId: "m1" }],
    ])
  })

  it("decodes text with the charset of its MIME part", async () => {
    const latin1 = btoa(String.fromCharCode(0x47, 0x72, 0xFC, 0xDF, 0x65)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    const part = (charset: string) => ({ body: { data: latin1 }, headers: [{ name: "Content-Type", value: `text/plain; charset="${charset}"` }], mimeType: "text/plain" })
    const { primitive } = connections({
      responses: { "gmail.users.messages.get": input => ({ ...message, payload: input.id === "unknown" ? part("x-unknown") : part("ISO-8859-1") }) },
    })
    const readTools = await tools(gmail(), primitive)
    expect(await run(readTools.gmail_read, { id: "m1" })).toMatchObject({ text: "Grüße" })
    // An unknown charset falls back to UTF-8 instead of failing.
    expect(await run(readTools.gmail_read, { id: "unknown" })).toMatchObject({ text: expect.any(String) })
  })

  it("reads MIME charset parameters without matching text inside quoted values", async () => {
    const encoded = (text: string) => btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    const { primitive } = connections({ responses: { "gmail.users.messages.get": input => ({
      ...message,
      payload: {
        mimeType: "text/plain",
        body: { data: input.id === "quoted" ? encoded(String.fromCharCode(0xC3, 0xBC)) : encoded(String.fromCharCode(0xFC)) },
        headers: [{ name: "Content-Type", value: input.id === "quoted"
          ? 'text/plain; name="notes; charset=ISO-8859-1"; charset=UTF-8'
          : 'text/plain; charset = "ISO-8859-1"' }],
      },
    }) } })
    const readTools = await tools(gmail(), primitive)
    expect(await run(readTools.gmail_read, { id: "quoted" })).toMatchObject({ text: "ü" })
    expect(await run(readTools.gmail_read, { id: "spaces" })).toMatchObject({ text: "ü" })
  })

  it("rejects an unexpected Gmail response", async () => {
    const { primitive } = connections({ responses: { "gmail.users.messages.get": () => ({ id: 1 }) } })
    await expect(run((await tools(gmail(), primitive)).gmail_read, { id: "m1" })).rejects.toThrow("unexpected Gmail response")
  })

  it("creates an unsent draft as an RFC 2822 message", async () => {
    const { primitive, runtime } = connections({
      responses: { "gmail.users.drafts.create": () => ({ id: "d1", message: { id: "m2", threadId: "t1" } }) },
    })
    const draftTools = await tools(gmail({ operations: ["draft"] }), primitive)
    const body = `Hallo Bob ✓\n${"y".repeat(100)}`
    expect(await run(draftTools.gmail_draft, {
      body,
      cc: ["carol@example.com"],
      subject: "Grüße",
      to: ["bob@example.com"],
    })).toEqual({ draftId: "d1", messageId: "m2", sent: false, threadId: "t1" })

    const input = (runtime.call.mock.calls[0]?.[1]?.requestBody as { message?: { raw?: string, threadId?: string } } | undefined)?.message
    expect(input?.threadId).toBeUndefined()
    const raw = decodeBase64Url(String(input?.raw))
    const [head = "", encoded = ""] = raw.split("\r\n\r\n")
    expect(head.split("\r\n")).toEqual([
      "To: bob@example.com",
      "Cc: carol@example.com",
      `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode("Grüße")))}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ])
    expect(encoded.split("\r\n").every(line => line.length <= 76)).toBe(true)
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll("\r\n", "")), character => character.charCodeAt(0)))).toBe(body)

    await expect(run(draftTools.gmail_draft, { body: "x", subject: "Hi\nBcc: evil@example.com", to: ["bob@example.com"] })).rejects.toThrow("one line")
    await expect(run(draftTools.gmail_draft, { body: "x", subject: "Hi", to: ["bob@example.com\r\nBcc: evil@example.com"] })).rejects.toThrow("valid email")
    await expect(run(draftTools.gmail_draft, { body: "x", subject: "Hi", to: [] })).rejects.toThrow("at least one email")
    await expect(run(draftTools.gmail_draft, { body: "x", to: ["bob@example.com"] })).rejects.toThrow("subject must be one line")
    expect(runtime.call).toHaveBeenCalledTimes(1)
  })

  it("creates a reply draft with the thread, reply headers, and original subject", async () => {
    const original = {
      id: "m1",
      payload: { headers: [
        { name: "Subject", value: "Re: Quarterly report" },
        { name: "Message-ID", value: "<b@mail.example.com>" },
        { name: "References", value: "<a@mail.example.com>" },
      ] },
      threadId: "t9",
    }
    const { primitive, runtime } = connections({
      responses: {
        "gmail.users.drafts.create": () => ({ id: "d2", message: { id: "m3", threadId: "t9" } }),
        "gmail.users.messages.get": () => original,
      },
    })
    const draftTools = await tools(gmail({ operations: ["draft"] }), primitive)
    expect(await run(draftTools.gmail_draft, { body: "Thanks", replyTo: "m1", to: ["alice@example.com"] }))
      .toEqual({ draftId: "d2", messageId: "m3", sent: false, threadId: "t9" })

    expect(runtime.call.mock.calls[0]?.[1]).toEqual({ userId: "me", format: "metadata", id: "m1", metadataHeaders: ["Message-ID", "References", "Subject"] })
    const draft = (runtime.call.mock.calls[1]?.[1]?.requestBody as { message?: { raw?: string, threadId?: string } } | undefined)?.message
    expect(draft?.threadId).toBe("t9")
    const head = decodeBase64Url(String(draft?.raw)).split("\r\n\r\n")[0]!.split("\r\n")
    expect(head).toContain("Subject: Re: Quarterly report")
    expect(head).toContain("In-Reply-To: <b@mail.example.com>")
    expect(head).toContain("References: <a@mail.example.com> <b@mail.example.com>")

    await expect(run(draftTools.gmail_draft, { body: "x", replyTo: "m1", subject: "Other topic", to: ["alice@example.com"] })).rejects.toThrow("must match the original subject")
    await expect(run(draftTools.gmail_draft, { body: "x", replyTo: "m1", subject: "RE: Quarterly report", to: ["alice@example.com"] })).resolves.toMatchObject({ draftId: "d2" })
  })

  it("rejects a reply when the original message has no Message-ID", async () => {
    const { primitive, runtime } = connections({
      responses: { "gmail.users.messages.get": () => ({ id: "m1", payload: { headers: [{ name: "Subject", value: "Hi" }] }, threadId: "t1" }) },
    })
    const draftTools = await tools(gmail({ operations: ["draft"] }), primitive)
    await expect(run(draftTools.gmail_draft, { body: "x", replyTo: "m1", to: ["alice@example.com"] })).rejects.toThrow("no valid Message-ID")
    expect(runtime.call).toHaveBeenCalledTimes(1)
  })

})
