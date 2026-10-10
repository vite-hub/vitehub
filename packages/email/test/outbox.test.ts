import { afterEach, describe, expect, it, vi } from "vitest"

import { createEmail } from "../src/client.ts"
import { emailProviderError } from "../src/provider.ts"
import { createEmailDevOutboxDriver, defaultEmailOutboxLimit, getEmailOutbox } from "../src/runtime/outbox.ts"

import type { EmailDriver, EmailMessage } from "../src/types.ts"

const outboxState = Symbol.for("vitehub.email.outbox")

afterEach(() => {
  Reflect.deleteProperty(globalThis, outboxState)
})

const message: EmailMessage = {
  from: { email: "hello@example.com", name: "Example" },
  html: "<p>Hello <script>alert(1)</script></p>",
  subject: "Welcome",
  text: "Hello",
  to: ["ada@example.com", { email: "grace@example.com", name: "Grace" }],
}

function providerDriver(send: EmailDriver["send"] = (_, context) => ({ data: { at: new Date(), driver: "resend", id: "re_1", stream: context.stream }, error: null })): EmailDriver {
  return { initialize: vi.fn(), name: "resend", send: vi.fn(send) }
}

describe("Email development outbox", () => {
  it("captures sends in submission order while provider delivery is pending", async () => {
    const completions: Array<(result: Awaited<ReturnType<EmailDriver["send"]>>) => void> = []
    const driver = providerDriver(() => new Promise(resolve => completions.push(resolve)))
    const wrapped = await createEmailDevOutboxDriver({ deliver: true, driver, provider: "resend" })
    const context = { attempt: 1, driver: "resend", meta: {} }
    const first = wrapped.send({ ...message, subject: "first" }, context)
    const second = wrapped.send({ ...message, subject: "second" }, context)
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    expect(getEmailOutbox()?.list().map(entry => [entry.id, entry.subject, entry.delivery.status])).toEqual([
      ["outbox-2", "second", "pending"], ["outbox-1", "first", "pending"],
    ])
    completions[1]!({ data: { at: new Date(), driver: "resend", id: "second" }, error: null })
    await second
    completions[0]!({ data: { at: new Date(), driver: "resend", id: "first" }, error: null })
    await first
    expect(getEmailOutbox()?.list().map(entry => [entry.id, entry.delivery.status])).toEqual([["outbox-2", "sent"], ["outbox-1", "sent"]])
  })

  it("shares provider initialization across concurrent and later deliveries", async () => {
    let finishInitialization: (() => void) | undefined
    const initialize = vi.fn(() => new Promise<void>((resolve) => {
      finishInitialization = resolve
    }))
    const driver = { ...providerDriver(), initialize }
    const email = createEmail({ driver: await createEmailDevOutboxDriver({ deliver: true, driver, provider: "resend" }) })

    const first = email.send(message)
    const second = email.send(message)
    await vi.waitFor(() => expect(getEmailOutbox()?.list()).toHaveLength(2))
    const initializationCount = initialize.mock.calls.length
    expect(driver.send).not.toHaveBeenCalled()
    expect(getEmailOutbox()?.list().map(entry => entry.delivery.status)).toEqual(["pending", "pending"])

    finishInitialization!()
    await Promise.all([first, second])
    await email.send(message)

    expect(initializationCount).toBe(1)
    expect(initialize).toHaveBeenCalledOnce()
    expect(driver.send).toHaveBeenCalledTimes(3)
    expect(getEmailOutbox()?.list().map(entry => entry.delivery.status)).toEqual(["sent", "sent", "sent"])
  })

  it.each(["synchronous", "asynchronous"])("retries %s provider initialization failures and records each delivery", async (failure) => {
    const cause = new Error("temporarily unavailable")
    const initialize = vi.fn().mockImplementationOnce(() => {
      if (failure === "synchronous") throw cause
      return Promise.reject(cause)
    }).mockResolvedValue(undefined)
    const driver = { ...providerDriver(), initialize }
    const email = createEmail({ driver: await createEmailDevOutboxDriver({ deliver: true, driver, provider: "resend" }) })

    await expect(email.send(message)).rejects.toMatchObject({ code: "EMAIL_PROVIDER_FAILED", cause })
    expect(driver.send).not.toHaveBeenCalled()
    await email.send(message)
    await email.send(message)

    expect(initialize).toHaveBeenCalledTimes(2)
    expect(driver.send).toHaveBeenCalledTimes(2)
    expect(getEmailOutbox()?.list().map(entry => entry.delivery.status)).toEqual(["sent", "sent", "failed"])
  })

  it("captures effective personalized recipients and subject", async () => {
    const email = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: providerDriver(), provider: "resend" }) })
    await email.send({ ...message, personalizations: [{ to: "personal@example.com", cc: "cc@example.com", bcc: "bcc@example.com", subject: "Personal" }] })
    expect(getEmailOutbox()?.list()[0]).toMatchObject({ to: ["personal@example.com"], cc: ["cc@example.com"], bcc: ["bcc@example.com"], subject: "Personal" })
  })

  it("isolates messages, limits, clear, and ids between runtime identities", async () => {
    const first = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: providerDriver(), limit: 2, provider: "resend", runtimeId: "first-runtime" }) })
    const second = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: providerDriver(), limit: 5, provider: "resend", runtimeId: "second-runtime" }) })
    await first.send({ ...message, subject: "first" })
    await second.send({ ...message, subject: "second" })
    expect(getEmailOutbox("first-runtime")?.list()).toMatchObject([{ id: "outbox-1", subject: "first" }])
    expect(getEmailOutbox("second-runtime")?.list()).toMatchObject([{ id: "outbox-1", subject: "second" }])
    expect(getEmailOutbox("first-runtime")?.limit).toBe(2)
    expect(getEmailOutbox("second-runtime")?.limit).toBe(5)
    expect(getEmailOutbox("restart-runtime")).toBeUndefined()
    getEmailOutbox("second-runtime")?.clear()
    expect(getEmailOutbox("first-runtime")?.list()).toHaveLength(1)
  })

  it("does not exist before the first send", () => {
    expect(getEmailOutbox()).toBeUndefined()
  })

  it("captures messages without delivery and never creates the provider driver", async () => {
    const createProviderDriver = vi.fn(() => providerDriver())
    const email = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: createProviderDriver, provider: "resend" }) })

    await expect(email.send({
      ...message,
      attachments: [
        { content: "a,b\n1,2\n", contentType: "text/csv", filename: "report.csv" },
        { cid: "logo", content: new Uint8Array(12), disposition: "inline", filename: "logo.png" },
      ],
      bcc: "audit@example.com",
      cc: ["team@example.com"],
      metadata: { apiKey: "re_live_secret", campaign: "spring" },
      preheader: "Start here",
      replyTo: "support@example.com",
      scheduledAt: new Date("2026-10-01T09:00:00.000Z"),
      tags: [{ name: "category", value: "welcome" }],
    })).resolves.toEqual({ driver: "outbox", id: "outbox-1" })

    expect(createProviderDriver).not.toHaveBeenCalled()
    const outbox = getEmailOutbox()
    expect(outbox?.limit).toBe(defaultEmailOutboxLimit)
    const captured = outbox?.get("outbox-1")
    expect(captured).toMatchObject({
      attachments: [
        { contentType: "text/csv", filename: "report.csv", size: 8 },
        { cid: "logo", disposition: "inline", filename: "logo.png", size: 12 },
      ],
      bcc: ["audit@example.com"],
      cc: ["team@example.com"],
      delivery: { status: "captured" },
      from: "\"Example\" <hello@example.com>",
      headers: {},
      html: message.html,
      id: "outbox-1",
      metadata: { apiKey: "[redacted]", campaign: "spring" },
      preheader: "Start here",
      provider: "resend",
      replyTo: ["support@example.com"],
      scheduledAt: "2026-10-01T09:00:00.000Z",
      subject: "Welcome",
      tags: [{ name: "category", value: "welcome" }],
      text: "Hello",
      to: ["ada@example.com", "\"Grace\" <grace@example.com>"],
    })
    expect(JSON.stringify(captured)).not.toContain("a,b")
    expect(Number.isNaN(Date.parse(captured?.capturedAt ?? ""))).toBe(false)
  })

  it("records the headers that ViteHub adds and redacts credentials in them", async () => {
    const email = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: providerDriver(), provider: "resend" }) })

    await email.send({
      ...message,
      headers: { "Authorization": "Bearer re_live_secret", "X-Campaign": "spring" },
      unsubscribe: { url: "https://example.com/unsubscribe?token=abc123" },
    })

    const headers = getEmailOutbox()?.list()[0]?.headers
    expect(headers).toMatchObject({
      "Authorization": "[redacted]",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-Campaign": "spring",
    })
    expect(headers?.["List-Unsubscribe"]).toContain("https://example.com/unsubscribe?token=[redacted]")
    expect(JSON.stringify(headers)).not.toContain("re_live_secret")
    expect(JSON.stringify(headers)).not.toContain("abc123")
  })

  it("delivers through the provider driver and records the provider id", async () => {
    const driver = providerDriver()
    const email = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: true, driver: () => driver, provider: "resend" }) })

    await expect(email.send(message)).resolves.toEqual({ driver: "resend", id: "re_1" })

    expect(driver.initialize).toHaveBeenCalledOnce()
    expect(driver.send).toHaveBeenCalledOnce()
    expect(getEmailOutbox()?.list()[0]).toMatchObject({ delivery: { id: "re_1", status: "sent" }, id: "outbox-1", provider: "resend" })
  })

  it("does not record malformed provider ids as sent", async () => {
    const driver = providerDriver(() => ({ data: { at: new Date(), driver: "resend", id: "" }, error: null }))
    const email = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: true, driver, provider: "resend" }) })

    await expect(email.send(message)).rejects.toMatchObject({ code: "EMAIL_PROVIDER_FAILED" })
    expect(getEmailOutbox()?.list()[0]?.delivery).toEqual({ error: { message: "Email driver returned an invalid message id." }, status: "failed" })
  })

  it("resolves and initializes a provider for every generated factory send", async () => {
    const initialize = vi.fn()
    const factory = vi.fn(() => ({ ...providerDriver(), initialize }))
    const email = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: true, driver: factory, provider: "resend" }) })

    await email.send(message)
    await email.send(message)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(getEmailOutbox()?.list().map(entry => entry.delivery.status)).toEqual(["sent", "sent"])
  })

  it("records failed deliveries with a redacted error and keeps the original failure", async () => {
    const rejected = providerDriver(() => ({ data: null, error: emailProviderError("resend", "AUTH", "Invalid key token=re_live_secret") }))
    const email = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: true, driver: rejected, provider: "resend" }) })
    await expect(email.send(message)).rejects.toMatchObject({ code: "EMAIL_AUTHENTICATION" })

    const thrown = providerDriver(() => {
      throw new Error("socket closed")
    })
    const failing = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: true, driver: thrown, provider: "resend" }) })
    await expect(failing.send(message)).rejects.toMatchObject({ code: "EMAIL_PROVIDER_FAILED" })

    const [second, first] = getEmailOutbox()?.list() ?? []
    expect(first?.delivery).toEqual({ error: { code: "AUTH", message: "Invalid key token=[redacted]" }, status: "failed" })
    expect(second?.delivery).toEqual({ error: { message: "socket closed" }, status: "failed" })
  })

  it("records the message when the provider driver cannot be created", async () => {
    const email = createEmail({
      driver: () => createEmailDevOutboxDriver({
        deliver: true,
        driver: () => {
          throw emailProviderError("resend", "INVALID_OPTIONS", "Missing RESEND_API_KEY.")
        },
        provider: "resend",
      }),
    })

    await expect(email.send(message)).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" })
    expect(getEmailOutbox()?.list()[0]).toMatchObject({
      delivery: { error: { code: "INVALID_OPTIONS", message: "Missing RESEND_API_KEY." }, status: "failed" },
      provider: "resend",
      subject: "Welcome",
    })
  })

  it("keeps only the newest messages up to the limit", async () => {
    const email = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: providerDriver(), limit: 2, provider: "resend" }) })

    for (const subject of ["First", "Second", "Third"]) await email.send({ ...message, subject })

    const outbox = getEmailOutbox()
    expect(outbox?.limit).toBe(2)
    expect(outbox?.list().map(entry => [entry.id, entry.subject])).toEqual([["outbox-3", "Third"], ["outbox-2", "Second"]])
    expect(outbox?.get("outbox-1")).toBeUndefined()
    expect(outbox?.clear()).toBe(2)
    expect(outbox?.list()).toEqual([])
    await email.send(message)
    expect(outbox?.list()[0]?.id).toBe("outbox-4")
  })

  it("applies a smaller limit to messages that the outbox already keeps", async () => {
    await createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: providerDriver(), limit: 5, provider: "resend" }) })
      .send(message)
    await createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: providerDriver(), limit: 5, provider: "resend" }) })
      .send(message)

    await createEmailDevOutboxDriver({ deliver: false, driver: providerDriver(), limit: 1, provider: "resend" })
    expect(getEmailOutbox()?.list().map(entry => entry.id)).toEqual(["outbox-2"])
  })
})
