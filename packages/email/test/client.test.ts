import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

import { createEmail } from "../src/index.ts"
import { emailProviderError, isEmailProviderError } from "../src/provider.ts"
import { email } from "../src/server.ts"

import type { EmailClient, EmailDriver, EmailMessage } from "../src/index.ts"
import type { EmailProviderError } from "../src/types.ts"

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

async function sendError(client: EmailClient, input: EmailMessage = message) {
  const [error, data] = await client.send(input)
  expect(data).toBeUndefined()
  return error
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

  it("rejects an inherited driver marker", () => {
    const definition = Object.create({ driver: fixtureDriver() })
    expect(() => createEmail(definition as never)).toThrow(expect.objectContaining({ code: "EMAIL_INVALID_DRIVER" }))
  })

  it("preserves the portable message contract and normalizes the result", async () => {
    const driver = fixtureDriver()
    const client = createEmail({ driver })

    await expect(client.send(message)).resolves.toEqual([undefined, { driver: "fixture", id: "provider-1" }])
    expect(driver.send).toHaveBeenCalledWith(message, {
      attempt: 1,
      driver: "fixture",
      meta: {},
      signal: undefined,
      stream: undefined,
    })
  })

  it("resolves a lazy driver for each send", async () => {
    const initialize = vi.fn()
    const factory = vi.fn(() => ({ ...fixtureDriver(), initialize }))
    const client = createEmail({ driver: factory })

    await client.send(message)
    await client.send(message)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(initialize).toHaveBeenCalledTimes(2)
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

    expect(await sendError(client)).toMatchObject({ code: "EMAIL_PROVIDER_FAILED" })
    await expect(client.send(message)).resolves.toEqual([undefined, { driver: "fixture", id: "provider-1" }])
    expect(initialize).toHaveBeenCalledTimes(2)
  })

  it("applies portable headers and preserves personalizations for the driver", async () => {
    const driver = fixtureDriver()
    const client = createEmail({ driver })

    await client.send({
      ...message,
      personalizations: [
        { customArgs: { campaign: "welcome" }, subject: "Personal welcome", to: "jane@example.com", variables: { name: "Jane" } },
        { sendAt: "2026-08-10T15:00:00.000Z", to: "john@example.com", variables: { name: "John" } },
      ],
      unsubscribe: { mailto: "leave@example.com", url: "https://example.com/unsubscribe" },
    })

    const preparedMessage = vi.mocked(driver.send).mock.calls[0]![0]
    expect(preparedMessage).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        "List-Unsubscribe": "<https://example.com/unsubscribe>, <mailto:leave@example.com>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }),
      subject: message.subject,
      to: message.to,
    }))
    expect(preparedMessage.personalizations).toEqual([
      { customArgs: { campaign: "welcome" }, subject: "Personal welcome", to: "jane@example.com", variables: { name: "Jane" } },
      { sendAt: "2026-08-10T15:00:00.000Z", to: "john@example.com", variables: { name: "John" } },
    ])
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
    ["INVALID_OPTIONS", "EMAIL_INVALID_MESSAGE"],
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

    expect(await sendError(client)).toMatchObject({
      cause,
      code,
      docs: `https://vitehub.dev/docs/email/limits-and-errors#${code.toLowerCase()}`,
      fix: expect.any(String),
      why: expect.stringContaining("fixture"),
    })
  })

  it("preserves the resolved driver on unsubscribe validation errors", async () => {
    const send = vi.fn()
    const client = createEmail({ driver: fixtureDriver(send) })

    expect(await sendError(client, { ...message, unsubscribe: { oneClick: true, url: "http://example.com" } })).toMatchObject({
      code: "EMAIL_INVALID_MESSAGE",
      why: "The fixture Email driver rejected the message.",
    })
    expect(send).not.toHaveBeenCalled()
  })

  it("rejects a successful result without a provider message ID", async () => {
    const client = createEmail({
      driver: fixtureDriver(vi.fn(async () => ({
        data: { at: new Date(), driver: "fixture", id: "" },
        error: null,
      }))),
    })

    expect(await sendError(client)).toMatchObject({
      cause: expect.objectContaining({ message: "The fixture Email driver returned an invalid message id." }),
      code: "EMAIL_PROVIDER_FAILED",
      why: "Email delivery through fixture failed.",
    })
  })

  it("uses the validated driver name in a successful result", async () => {
    const client = createEmail({
      driver: fixtureDriver(vi.fn(async () => ({
        data: { at: new Date(), driver: "", id: "provider-1" },
        error: null,
      }))),
    })

    await expect(client.send(message)).resolves.toEqual([undefined, { driver: "fixture", id: "provider-1" }])
  })

  it("returns provider errors thrown while resolving the driver", async () => {
    const cause = emailProviderError("fixture", "RATE_LIMIT", "Try again later.")
    const client = createEmail({
      driver: () => {
        throw cause
      },
    })

    expect(await sendError(client)).toMatchObject({ cause, code: "EMAIL_RATE_LIMITED" })
  })

  it("throws config errors while resolving the driver", async () => {
    const cause = emailProviderError("fixture", "NOT_CONFIGURED", "apiKey is required.")
    const invalidOptions = createEmail({
      driver: () => {
        throw cause
      },
    })
    await expect(invalidOptions.send(message)).rejects.toMatchObject({
      cause,
      code: "EMAIL_NOT_CONFIGURED",
      why: "The options of the fixture Email driver are not valid.",
    })

    const invalidDriver = createEmail({ driver: () => ({}) as EmailDriver })
    await expect(invalidDriver.send(message)).rejects.toMatchObject({ code: "EMAIL_INVALID_DRIVER" })
  })

  it("maps structurally valid provider errors from another realm", async () => {
    const cause = runInNewContext(
      `Object.assign(new Error("slow down"), { code: "RATE_LIMIT", driver: "custom", retryable: true })`,
    ) as EmailProviderError
    const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })

    expect(await sendError(client)).toMatchObject({
      code: "EMAIL_RATE_LIMITED",
      why: expect.stringContaining("custom"),
    })
  })

  it("does not classify provider-shaped plain objects as errors", async () => {
    const cause = { code: "RATE_LIMIT", driver: "custom", message: "slow down" } as EmailProviderError
    const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })

    expect(await sendError(client)).toMatchObject({
      code: "EMAIL_PROVIDER_FAILED",
      why: expect.stringContaining("fixture"),
    })
  })

  it("preserves tagged provider errors without native Error.isError", async () => {
    const cause = Object.assign(new Error("slow down"), {
      code: "RATE_LIMIT" as const,
      driver: "custom",
      retryable: true,
      [Symbol.toStringTag]: "ProviderError",
    })
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })
      expect(await sendError(client)).toMatchObject({ code: "EMAIL_RATE_LIMITED", why: expect.stringContaining("custom") })
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("preserves tagged provider errors from another realm without native Error.isError", async () => {
    const cause = runInNewContext(
      `Object.assign(new Error("slow down"), { code: "RATE_LIMIT", driver: "custom", [Symbol.toStringTag]: "ProviderError" })`,
    ) as EmailProviderError
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })
      expect(await sendError(client)).toMatchObject({ code: "EMAIL_RATE_LIMITED", why: expect.stringContaining("custom") })
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("rejects tagged objects with a custom prototype without native Error.isError", async () => {
    const cause = Object.create({ [Symbol.toStringTag]: "Error" }) as EmailProviderError
    Object.assign(cause, { code: "RATE_LIMIT", driver: "custom", message: "slow down" })
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })
      expect(await sendError(client)).toMatchObject({ code: "EMAIL_PROVIDER_FAILED", why: expect.stringContaining("fixture") })
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("rejects objects that only inherit Error.prototype without native Error.isError", async () => {
    const cause = Object.assign(Object.create(Error.prototype), {
      code: "RATE_LIMIT" as const,
      driver: "custom",
      message: "slow down",
    }) as EmailProviderError
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })
      expect(await sendError(client)).toMatchObject({ code: "EMAIL_PROVIDER_FAILED", why: expect.stringContaining("fixture") })
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("rejects an own-stack Error.prototype impostor without native Error.isError", async () => {
    const cause = Object.assign(Object.create(Error.prototype), {
      stack: "spoofed stack",
      code: "RATE_LIMIT" as const,
      driver: "custom",
      message: "slow down",
    }) as EmailProviderError
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })
      expect(await sendError(client)).toMatchObject({ code: "EMAIL_PROVIDER_FAILED", why: expect.stringContaining("fixture") })
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("rejects an own-stack impostor when native brand intrinsics are unavailable", async () => {
    const cause = Object.assign(Object.create(Error.prototype), {
      stack: "spoofed stack",
      code: "RATE_LIMIT" as const,
      driver: "custom",
      message: "slow down",
    }) as EmailProviderError
    const errorDescriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    const cloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, "structuredClone")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    Object.defineProperty(globalThis, "structuredClone", { configurable: true, value: undefined })
    try {
      const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })
      expect(await sendError(client)).toMatchObject({ code: "EMAIL_PROVIDER_FAILED", why: expect.stringContaining("fixture") })
    }
    finally {
      if (errorDescriptor) Object.defineProperty(Error, "isError", errorDescriptor)
      else Reflect.deleteProperty(Error, "isError")
      if (cloneDescriptor) Object.defineProperty(globalThis, "structuredClone", cloneDescriptor)
      else Reflect.deleteProperty(globalThis, "structuredClone")
    }
  })

  it.each([
    { realm: "same realm", create: () => Object.assign(new (class Error {})(), { code: "RATE_LIMIT", driver: "custom", message: "slow down" }) },
    { realm: "foreign realm", create: () => runInNewContext('Object.assign(new (class Error {})(), { code: "RATE_LIMIT", driver: "custom", message: "slow down" })') },
  ])("rejects a user class named Error from the $realm without native Error.isError", async ({ create }) => {
    const cause = create() as EmailProviderError
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })
      expect(await sendError(client)).toMatchObject({ code: "EMAIL_PROVIDER_FAILED", why: expect.stringContaining("fixture") })
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("preserves tagged foreign Error subclasses without native Error.isError", async () => {
    const cause = runInNewContext(
      'Object.assign(new (class ProviderError extends TypeError {})("slow down"), { code: "RATE_LIMIT", driver: "custom", [Symbol.toStringTag]: "ProviderError" })',
    ) as EmailProviderError
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })
      expect(await sendError(client)).toMatchObject({ code: "EMAIL_RATE_LIMITED", why: expect.stringContaining("custom") })
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it.each(["cyclic", "fresh"])("bounds a %s proxy prototype chain without native Error.isError", (kind) => {
    let reads = 0
    let proxy: object
    const handler: ProxyHandler<object> = {
      getPrototypeOf() {
        reads++
        return kind === "cyclic" ? proxy : new Proxy({}, handler)
      },
    }
    proxy = new Proxy({}, handler)
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      expect(isEmailProviderError(proxy)).toBe(false)
      expect(reads).toBeLessThanOrEqual(65)
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("rejects failed prototype reflection without native Error.isError", () => {
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("reflection failed") } })
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      expect(isEmailProviderError(proxy)).toBe(false)
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("preserves structurally valid custom provider errors", async () => {
    const cause = Object.assign(new Error("slow down"), { code: "RATE_LIMIT" as const, driver: "custom", retryable: true })
    const client = createEmail({ driver: fixtureDriver(async () => ({ data: null, error: cause })) })

    expect(await sendError(client)).toMatchObject({ code: "EMAIL_RATE_LIMITED", why: expect.stringContaining("custom") })
  })
})

it("reports a missing configured Email provider", async () => {
  await expect(email.send(message)).rejects.toMatchObject({
    code: "EMAIL_NOT_CONFIGURED",
    fix: expect.stringContaining("vitehub({ email: { driver, options } })"),
    why: "No Email provider is configured.",
  })
})
