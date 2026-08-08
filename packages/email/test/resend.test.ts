import { afterEach, describe, expect, it, vi } from "vitest"

import { createEmail } from "../src/index.ts"
import { resend } from "../src/drivers/resend.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("resend", () => {
  it("maps the portable message contract to the Resend API", async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return Response.json({ id: "resend-1" })
    })
    vi.stubGlobal("fetch", fetch)
    const client = createEmail({ driver: resend({ apiKey: " secret " }) })

    await expect(
      client.send({
        attachments: [
          {
            cid: "logo",
            content: new Uint8Array([1, 2, 3]),
            contentType: "image/png",
            filename: "logo.png",
          },
          {
            content: "Hola 👋",
            filename: "hello.txt",
          },
        ],
        bcc: "audit@example.com",
        cc: [{ email: "reviewer@example.com", name: 'Reviewer, "QA\\Lead"' }],
        from: { email: "hello@example.com", name: "ViteHub" },
        headers: { "X-Trace-Id": "trace-1" },
        html: "<p>Hello</p>",
        replyTo: "support@example.com",
        subject: "Welcome",
        text: "Hello",
        to: ["maxi@example.com"],
      }),
    ).resolves.toEqual({ driver: "resend", id: "resend-1" })

    expect(fetch).toHaveBeenCalledOnce()
    const request = requests[0]!
    expect(request.url).toBe("https://api.resend.com/emails")
    expect(request.method).toBe("POST")
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(request.headers.get("authorization")).toBe("Bearer secret")
    expect(request.headers.get("user-agent")).toBe("vitehub-email")
    expect(await request.json()).toEqual({
      attachments: [
        {
          content: "AQID",
          content_id: "logo",
          content_type: "image/png",
          filename: "logo.png",
        },
        {
          content: "SG9sYSDwn5GL",
          filename: "hello.txt",
        },
      ],
      bcc: ["audit@example.com"],
      cc: ['"Reviewer, \\"QA\\\\Lead\\"" <reviewer@example.com>'],
      from: '"ViteHub" <hello@example.com>',
      headers: { "X-Trace-Id": "trace-1" },
      html: "<p>Hello</p>",
      reply_to: ["support@example.com"],
      subject: "Welcome",
      text: "Hello",
      to: ["maxi@example.com"],
    })
  })

  it("resolves a runtime credential for every send", async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return Response.json({ id: "resend-1" })
    })
    vi.stubGlobal("fetch", fetch)
    let apiKey = "first"
    const driver = resend({ apiKey: async () => apiKey })
    const message = {
      from: "hello@example.com",
      subject: "Welcome",
      text: "Hello",
      to: "maxi@example.com",
    } as const

    await driver.send(message)
    apiKey = "second"
    await driver.send(message)

    expect(requests[0]?.headers.get("authorization")).toBe("Bearer first")
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer second")
  })

  it.each([
    [
      403,
      { message: "API key is invalid.", name: "invalid_api_key", statusCode: 403 },
      "EMAIL_AUTHENTICATION",
    ],
    [
      403,
      { message: "Domain is not verified.", name: "validation_error", statusCode: 403 },
      "EMAIL_PROVIDER_FAILED",
    ],
    [
      409,
      { message: "Try again.", name: "concurrent_idempotent_requests", statusCode: 409 },
      "EMAIL_PROVIDER_FAILED",
    ],
    [
      429,
      { message: "Too many requests.", name: "rate_limit_exceeded", statusCode: 429 },
      "EMAIL_RATE_LIMITED",
    ],
  ])("preserves Resend failures for HTTP %s", async (status, provider, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(provider, {
          headers: { "retry-after": "2", "x-private-header": "private" },
          status,
        }),
      ),
    )
    const client = createEmail({ driver: resend({ apiKey: "secret-123" }) })

    let failure: unknown
    try {
      await client.send({
        from: "hello@example.com",
        subject: "Welcome",
        text: "Hello",
        to: "maxi@example.com",
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      cause: {
        headers: { "retry-after": "2" },
        message: provider.message,
        name: provider.name,
        statusCode: status,
      },
      code,
      details: { driver: "resend" },
      message: "[vitehub] Resend delivery failed.",
    })
    expect(
      (failure as { cause: { headers: Record<string, string> } }).cause.headers,
    ).not.toHaveProperty("x-private-header")
    expect(JSON.stringify(failure)).not.toContain("secret-123")
    expect(JSON.stringify(failure)).not.toContain(provider.message)
  })

  it("rejects unsupported attachment disposition before delivery", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const client = createEmail({ driver: resend({ apiKey: "secret" }) })

    await expect(
      client.send({
        attachments: [{ content: "hello", contentDisposition: "inline", filename: "hello.txt" }],
        from: "hello@example.com",
        subject: "Welcome",
        text: "Hello",
        to: "maxi@example.com",
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_INVALID_MESSAGE",
      details: { driver: "resend" },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("classifies missing credentials, timeouts, network failures, and invalid provider ids", async () => {
    const message = {
      from: "hello@example.com",
      subject: "Welcome",
      text: "Hello",
      to: "maxi@example.com",
    } as const

    await expect(resend({ apiKey: "" }).send(message)).rejects.toMatchObject({
      code: "EMAIL_NOT_CONFIGURED",
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      }),
    )
    await expect(resend({ apiKey: "secret" }).send(message)).rejects.toMatchObject({
      code: "EMAIL_TIMEOUT",
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }),
    )
    await expect(resend({ apiKey: "secret" }).send(message)).rejects.toMatchObject({
      code: "EMAIL_NETWORK",
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(null)),
    )
    await expect(resend({ apiKey: "secret" }).send(message)).rejects.toMatchObject({
      code: "EMAIL_PROVIDER_FAILED",
    })
  })
})
