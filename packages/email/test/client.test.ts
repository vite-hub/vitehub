import { describe, expect, it, vi } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"
import { createEmail } from "../src/index.ts"
import { emailProviderError } from "../src/provider.ts"
import { email } from "../src/server.ts"

import type { EmailDriver, EmailMessage } from "../src/index.ts"

const message: EmailMessage = {
  attachments: [
    {
      content: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
      disposition: "attachment",
      filename: "report.bin",
    },
  ],
  bcc: "audit@example.com",
  cc: [{ email: "reviewer@example.com", name: "Reviewer" }],
  from: { email: "hello@example.com", name: "ViteHub" },
  headers: { "X-Trace-Id": "trace-1" },
  html: "<p>Hello</p>",
  replyTo: "support@example.com",
  scheduledAt: new Date("2026-08-09T15:00:00.000Z"),
  subject: "Welcome",
  tags: [{ name: "kind", value: "welcome" }],
  text: "Hello",
  to: ["maxi@example.com"],
}

function fixtureDriver(
  send: EmailDriver["send"] = vi.fn(async () => ({
    data: { at: new Date(), driver: "fixture", id: "provider-1" },
    error: null,
  })),
): EmailDriver {
  return { name: "fixture", send }
}

describe("createEmail", () => {
  it("rejects an invalid eager driver", () => {
    expect(() => createEmail({ driver: {} as EmailDriver })).toThrow("name")
  })

  it("preserves the portable message contract and normalizes the result", async () => {
    const driver = fixtureDriver()
    const client = createEmail({ driver })

    await expect(client.send(message)).resolves.toEqual({ driver: "fixture", id: "provider-1" })
    expect(driver.send).toHaveBeenCalledWith(message, {
      attempt: 1,
      driver: "fixture",
      meta: {},
      signal: undefined,
      stream: undefined,
    })
  })

  it("resolves a lazy driver for each send", async () => {
    const factory = vi.fn(() => fixtureDriver())
    const client = createEmail({ driver: factory })

    await client.send(message)
    await client.send(message)

    expect(factory).toHaveBeenCalledTimes(2)
  })

  it("keeps an eager driver's lifecycle across sends", async () => {
    const initialize = vi.fn()
    const client = createEmail({ driver: { ...fixtureDriver(), initialize } })

    await client.send(message)
    await client.send(message)

    expect(initialize).toHaveBeenCalledOnce()
  })

  it("retries eager initialization after a transient failure", async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(undefined)
    const client = createEmail({ driver: { ...fixtureDriver(), initialize } })

    await expect(client.send(message)).rejects.toMatchObject({ code: "EMAIL_PROVIDER_FAILED" })
    await expect(client.send(message)).resolves.toEqual({ driver: "fixture", id: "provider-1" })
    expect(initialize).toHaveBeenCalledTimes(2)
  })

  it("applies unsubscribe headers and the first personalization before dispatch", async () => {
    const driver = fixtureDriver()
    const client = createEmail({ driver })

    await client.send({
      ...message,
      personalizations: [{ subject: "Personal welcome", to: "jane@example.com" }],
      unsubscribe: { mailto: "leave@example.com", url: "https://example.com/unsubscribe" },
    })

    expect(driver.send).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({
        "List-Unsubscribe": "<https://example.com/unsubscribe>, <mailto:leave@example.com>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }),
      personalizations: undefined,
      subject: "Personal welcome",
      to: "jane@example.com",
    }), expect.anything())
  })

  it("serializes concurrent initialization for an eager driver", async () => {
    let finishInitialization: (() => void) | undefined
    const initialize = vi.fn(() => new Promise<void>((resolve) => {
      finishInitialization = resolve
    }))
    const driver = fixtureDriver()
    const client = createEmail({ driver: { ...driver, initialize } })

    const first = client.send(message)
    const second = client.send(message)
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
    expect(driver.send).not.toHaveBeenCalled()

    finishInitialization!()
    await Promise.all([first, second])
    expect(driver.send).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["INVALID_OPTIONS", "EMAIL_NOT_CONFIGURED"],
    ["AUTH", "EMAIL_AUTHENTICATION"],
    ["NETWORK", "EMAIL_NETWORK"],
    ["RATE_LIMIT", "EMAIL_RATE_LIMITED"],
    ["TIMEOUT", "EMAIL_TIMEOUT"],
    ["PROVIDER", "EMAIL_PROVIDER_FAILED"],
    ["UNSUPPORTED", "EMAIL_PROVIDER_FAILED"],
    ["CANCELLED", "EMAIL_PROVIDER_FAILED"],
  ] as const)("maps provider %s failures to %s", async (providerCode, code) => {
    const cause = emailProviderError("fixture", providerCode, "provider unavailable")
    const client = createEmail({
      driver: fixtureDriver(vi.fn(async () => ({ data: null, error: cause }))),
    })

    await expect(client.send(message)).rejects.toMatchObject({
      cause,
      code,
      details: { driver: "fixture" },
      message: "[vitehub] Email delivery failed through fixture.",
    })
  })

  it("rejects a successful result without a provider message ID", async () => {
    const client = createEmail({
      driver: fixtureDriver(vi.fn(async () => ({
        data: { at: new Date(), driver: "fixture", id: "" },
        error: null,
      }))),
    })

    await expect(client.send(message)).rejects.toMatchObject({
      code: "EMAIL_PROVIDER_FAILED",
      details: { driver: "fixture" },
      message: "[vitehub] Email driver fixture returned an invalid message id.",
    })
  })

  it("uses the validated driver name in a successful result", async () => {
    const client = createEmail({
      driver: fixtureDriver(vi.fn(async () => ({
        data: { at: new Date(), driver: "", id: "provider-1" },
        error: null,
      }))),
    })

    await expect(client.send(message)).resolves.toEqual({ driver: "fixture", id: "provider-1" })
  })

  it("preserves ViteHub errors thrown while resolving the driver", async () => {
    const error = new ViteHubError("EMAIL_RATE_LIMITED", "Try again later.", {
      details: { driver: "fixture" },
    })
    const client = createEmail({
      driver: () => {
        throw error
      },
    })

    await expect(client.send(message)).rejects.toBe(error)
  })

  it("preserves structurally valid custom provider errors", async () => {
    const cause = Object.assign(new Error("slow down"), { code: "RATE_LIMIT" as const, driver: "custom", retryable: true })
    const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })

    await expect(client.send(message)).rejects.toMatchObject({ code: "EMAIL_RATE_LIMITED", details: { driver: "custom" } })
  })
})

it("reports a missing configured Email provider", async () => {
  await expect(email.send(message)).rejects.toMatchObject({
    code: "EMAIL_NOT_CONFIGURED",
    message: "[vitehub] No Email provider is configured. Set `vitehub({ email: { driver, options } })`.",
  })
})
