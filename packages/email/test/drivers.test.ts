import { describe, expect, it, vi } from "vitest"

import cloudflareEmail from "../src/drivers/cloudflare-email.ts"
import resend from "../src/drivers/resend.ts"

import type { EmailMessage } from "../src/types.ts"

const message: EmailMessage = {
  attachments: [{ content: new Uint8Array([1, 2, 3]), filename: "report.bin" }],
  from: { email: "hello@example.com", name: "ViteHub" },
  headers: { "X-Trace-Id": "trace-1" },
  html: "<p>Hello</p>",
  replyTo: "support@example.com",
  subject: "Welcome",
  tags: [{ name: "kind", value: "welcome" }],
  text: "Hello",
  to: ["maxi@example.com"],
}

const context = { attempt: 1, driver: "fixture", meta: {} }

describe("Resend Email driver", () => {
  it("rejects credentials that do not match Resend's API key shape", () => {
    expect(() => resend({ apiKey: "secret" })).toThrow("apiKey must start with 're_'")
  })

  it("maps the portable message and returns the provider id", async () => {
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) => new Response(JSON.stringify({ id: "email-1" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }))
    const driver = resend({ apiKey: "re_secret", fetch: request })

    await expect(driver.send({ ...message, idempotencyKey: "send-1", scheduledAt: new Date("2026-08-26T12:00:00.000Z") }, context)).resolves.toMatchObject({
      data: { driver: "resend", id: "email-1" },
      error: null,
    })
    const [url, init = {}] = request.mock.calls[0]!
    expect(url).toBe("https://api.resend.com/emails")
    expect(init.headers).toMatchObject({ authorization: "Bearer re_secret", "Idempotency-Key": "send-1" })
    expect(JSON.parse(init.body as string)).toMatchObject({
      attachments: [{ content: "AQID", filename: "report.bin" }],
      from: "\"ViteHub\" <hello@example.com>",
      reply_to: ["support@example.com"],
      scheduled_at: "2026-08-26T12:00:00.000Z",
      to: ["maxi@example.com"],
    })
  })

  it("encodes string attachments as UTF-8 base64", async () => {
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }))
    const driver = resend({ apiKey: "re_secret", fetch: request })

    await driver.send({ ...message, attachments: [{ content: "hello", filename: "hello.txt" }] }, context)

    expect(JSON.parse(request.mock.calls[0]![1]?.body as string).attachments).toEqual([{ content: "aGVsbG8=", filename: "hello.txt" }])
  })

  it("maps response body read failures to retryable network errors", async () => {
    const response = new Response(null, { status: 200 })
    vi.spyOn(response, "text").mockRejectedValue(new Error("connection reset"))
    const driver = resend({ apiKey: "re_secret", fetch: async () => response })

    await expect(driver.send(message, context)).resolves.toMatchObject({ error: { code: "NETWORK", retryable: true } })
  })

  it("forwards cancellation to fetch and classifies aborts", async () => {
    const controller = new AbortController()
    controller.abort()
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      throw new DOMException("aborted", "AbortError")
    })
    const driver = resend({ apiKey: "re_secret", fetch: request })

    await expect(driver.send(message, { ...context, signal: controller.signal })).resolves.toMatchObject({
      error: { code: "CANCELLED", driver: "resend", retryable: false },
    })
  })

  it("rejects invalid idempotency header values before fetch", async () => {
    const request = vi.fn()
    const driver = resend({ apiKey: "re_secret", fetch: request })

    await expect(driver.send({ ...message, idempotencyKey: "invalid\nvalue" }, context)).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "resend" },
    })
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects an invalid scheduled date without making a request", async () => {
    const request = vi.fn()
    const driver = resend({ apiKey: "re_secret", fetch: request })

    await expect(driver.send({ ...message, scheduledAt: new Date("invalid") }, context))
      .resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([[401, "AUTH"], [408, "TIMEOUT"], [429, "RATE_LIMIT"], [500, "NETWORK"], [400, "PROVIDER"]] as const)("maps HTTP %s to %s", async (status, code) => {
    const driver = resend({ apiKey: "re_secret", fetch: async () => new Response(JSON.stringify({ message: "failed" }), { status }) })
    await expect(driver.send(message, context)).resolves.toMatchObject({ error: { code, driver: "resend", status } })
  })

  it.each([200, 400])("handles a JSON null response with HTTP %s", async (status) => {
    const driver = resend({ apiKey: "re_secret", fetch: async () => new Response("null", { status }) })
    await expect(driver.send(message, context)).resolves.toMatchObject({ data: null, error: { code: "PROVIDER", driver: "resend" } })
  })
})

describe("Cloudflare Email driver", () => {
  it("constructs raw MIME and sends it through the binding", async () => {
    const send = vi.fn()
    const Constructor = vi.fn(function (this: Record<string, unknown>, from: string, to: string, raw: string) {
      Object.assign(this, { from, raw, to })
    })
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor as never })

    await expect(driver.send(message, context)).resolves.toMatchObject({ data: { driver: "cloudflare-email" }, error: null })
    expect(Constructor).toHaveBeenCalledWith("hello@example.com", "maxi@example.com", expect.stringContaining("Content-Type: multipart/mixed"))
    expect(Constructor.mock.calls[0]![2]).toContain("AQID")
    expect(Constructor.mock.calls[0]![2]).toContain("Content-Type: multipart/alternative")
    expect(Constructor.mock.calls[0]![2]).toContain("Content-Type: text/plain; charset=utf-8")
    expect(Constructor.mock.calls[0]![2]).toContain("Content-Type: text/html; charset=utf-8")
    expect(send).toHaveBeenCalledOnce()
  })

  it("quotes and escapes display names for both built-in drivers", async () => {
    const namedMessage = { ...message, from: { email: "jane@example.com", name: 'Doe, "Jane"' } }
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }))
    await resend({ apiKey: "re_secret", fetch: request }).send(namedMessage, context)
    expect(JSON.parse(request.mock.calls[0]![1]?.body as string).from).toBe('"Doe, \\"Jane\\"" <jane@example.com>')

    const Constructor = vi.fn()
    await cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor }).send(namedMessage, context)
    expect(Constructor.mock.calls[0]![2]).toContain('From: "Doe, \\"Jane\\"" <jane@example.com>')
  })

  it("normalizes syntax quotes in string display names", async () => {
    const quotedMessage = { ...message, from: '"Doe, Jane" <jane@example.com>' }
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }))
    await resend({ apiKey: "re_secret", fetch: request }).send(quotedMessage, context)
    expect(JSON.parse(request.mock.calls[0]![1]?.body as string).from).toBe('"Doe, Jane" <jane@example.com>')

    const Constructor = vi.fn()
    await cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor }).send(quotedMessage, context)
    expect(Constructor.mock.calls[0]![2]).toContain('From: "Doe, Jane" <jane@example.com>')
  })

  it("rejects multiple envelope recipients before sending", async () => {
    const send = vi.fn()
    const Constructor = vi.fn(function (this: Record<string, unknown>, from: string, to: string, raw: string) {
      Object.assign(this, { from, raw, to })
    })
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor as never })

    await expect(driver.send({
      ...message,
      bcc: "audit@example.com",
      cc: { email: "reviewer@example.com", name: "Reviewer" },
      to: ["maxi@example.com", "team@example.com"],
    }, context)).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "cloudflare-email" } })

    expect(Constructor).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("encodes string attachments as UTF-8 base64", async () => {
    const send = vi.fn()
    const Constructor = vi.fn(function (this: Record<string, unknown>, from: string, to: string, raw: string) {
      Object.assign(this, { from, raw, to })
    })
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor as never })

    await driver.send({ ...message, attachments: [{ content: "hello", filename: "hello.txt" }] }, context)

    expect(Constructor.mock.calls[0]![2]).toContain("aGVsbG8=")
  })

  it.each([
    ["text", "Gr\u00fc\u00dfe", "text/plain"],
    ["html", "<p>Gr\u00fc\u00dfe</p>", "text/html"],
  ] as const)("base64-encodes attached UTF-8 %s bodies", async (field, content, contentType) => {
    const Constructor = vi.fn()
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor })

    await driver.send({ ...message, html: undefined, text: undefined, [field]: content }, context)

    const raw = Constructor.mock.calls[0]![2] as string
    expect(raw).toContain(`Content-Type: ${contentType}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(content).toString("base64")}`)
  })

  it("folds long message bodies into transport-safe lines", async () => {
    const Constructor = vi.fn()
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor })

    await driver.send({ ...message, attachments: undefined, html: undefined, text: "x".repeat(1000) }, context)

    const raw = Constructor.mock.calls[0]![2] as string
    const encoded = raw.split("Content-Transfer-Encoding: base64\r\n\r\n")[1] ?? ""
    expect(encoded.split("\r\n").every(line => line.length <= 76)).toBe(true)
  })

  it.each(["first\nsecond", "first\rsecond", "first\r\nsecond"])("canonicalizes body newlines before transfer encoding", async (text) => {
    const Constructor = vi.fn()
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor })

    await driver.send({ ...message, attachments: undefined, html: undefined, scheduledAt: undefined, text }, context)

    const encoded = (Constructor.mock.calls[0]![2] as string).split("Content-Transfer-Encoding: base64\r\n\r\n")[1] ?? ""
    expect(Buffer.from(encoded.replaceAll("\r\n", ""), "base64").toString()).toBe("first\r\nsecond")
  })

  it("rejects scheduled delivery before sending", async () => {
    const send = vi.fn()
    const Constructor = vi.fn()
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor })

    await expect(driver.send({ ...message, scheduledAt: new Date("2026-08-26T12:00:00.000Z") }, context)).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "cloudflare-email" } })
    expect(Constructor).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ["raw message payloads", { raw: "From: hello@example.com\r\n\r\nHello" }],
    ["idempotency keys", { idempotencyKey: "send-1" }],
  ])("rejects unsupported %s before sending", async (_name, unsupported) => {
    const send = vi.fn()
    const Constructor = vi.fn()
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor })

    await expect(driver.send({ ...message, ...unsupported }, context))
      .resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "cloudflare-email" } })
    expect(Constructor).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    { headers: { "X-Long": "x".repeat(1000) }, subject: "Welcome" },
    { headers: undefined, subject: "x".repeat(1000) },
  ])("rejects overlong raw headers", async ({ headers, subject }) => {
    const send = vi.fn()
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() })

    await expect(driver.send({ ...message, headers, scheduledAt: undefined, subject }, context))
      .resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } })
    expect(send).not.toHaveBeenCalled()
  })

  it("preserves a case-insensitive custom message ID", async () => {
    const Constructor = vi.fn()
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor })

    await expect(driver.send({ ...message, headers: { "message-id": "<stable@example.com>" } }, context))
      .resolves.toMatchObject({ data: { id: "<stable@example.com>" }, error: null })
    expect(Constructor.mock.calls[0]![2]).toContain("Message-ID: <stable@example.com>")
  })

  it("rejects an empty custom message ID before delivery", async () => {
    const send = vi.fn()
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() })

    await expect(driver.send({ ...message, headers: { "message-id": "  " } }, context)).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
    })
    expect(send).not.toHaveBeenCalled()
  })

  it("folds attachment base64 and escapes quoted filenames", async () => {
    const Constructor = vi.fn()
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor })

    await driver.send({
      ...message,
      attachments: [{ content: new Uint8Array(120), filename: 'report\\"final.pdf' }],
    }, context)

    const raw = Constructor.mock.calls[0]![2] as string
    expect(raw).toContain('filename="report\\\\\\"final.pdf"')
    const encoded = raw.match(/Content-Transfer-Encoding: base64\r\nContent-Disposition: [^\r]+\r\n\r\n([\s\S]+?)\r\n--vitehub-/)?.[1] ?? ""
    expect(encoded.split("\r\n").every(line => line.length <= 76)).toBe(true)
    expect(encoded.replaceAll("\r\n", "")).toBe("A".repeat(160))
  })

  it("rejects header injection before sending", async () => {
    const send = vi.fn()
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() as never })
    await expect(driver.send({ ...message, subject: "Hello\r\nBcc: attacker@example.com" }, context))
      .resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } })
    expect(send).not.toHaveBeenCalled()
  })

  it.each(["Content-Type", "mime-version", "From", "Subject"])("rejects the transport-owned %s header", async (header) => {
    const send = vi.fn()
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() as never })

    await expect(driver.send({ ...message, headers: { [header]: "custom" } }, context))
      .resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } })
    expect(send).not.toHaveBeenCalled()
  })
})
