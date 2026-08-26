import { describe, expect, it, vi } from "vitest"

import cloudflareEmail from "../src/drivers/cloudflare-email.ts"
import resend from "../src/drivers/resend.ts"

import type { EmailMessage } from "../src/types.ts"

const message: EmailMessage = {
  attachments: [{ content: new Uint8Array([1, 2, 3]), filename: "report.bin" }],
  from: { email: "hello@example.com", name: "ViteHub" },
  headers: { "X-Trace-Id": "trace-1" },
  html: "<p>Hello</p>",
  idempotencyKey: "send-1",
  replyTo: "support@example.com",
  scheduledAt: new Date("2026-08-26T12:00:00.000Z"),
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

    await expect(driver.send(message, context)).resolves.toMatchObject({
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

  it.each([[401, "AUTH"], [429, "RATE_LIMIT"], [500, "NETWORK"], [400, "PROVIDER"]] as const)("maps HTTP %s to %s", async (status, code) => {
    const driver = resend({ apiKey: "re_secret", fetch: async () => new Response(JSON.stringify({ message: "failed" }), { status }) })
    await expect(driver.send(message, context)).resolves.toMatchObject({ error: { code, driver: "resend", status } })
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

  it("rejects header injection before sending", async () => {
    const send = vi.fn()
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() as never })
    await expect(driver.send({ ...message, subject: "Hello\r\nBcc: attacker@example.com" }, context))
      .resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } })
    expect(send).not.toHaveBeenCalled()
  })
})
