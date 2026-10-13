import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { defineChatCapability as chat } from "../src/chat-trigger.ts"
import { defineAgent, runAgentTrigger, verifyAgentWebhookRequest } from "../src/index.ts"
import type { ForgejoChannelOptions } from "../src/channels.ts"
import { createAgentRuntimeContext } from "../src/runtime/context.ts"

function runtime(request?: Request) {
  return {
    ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }),
    ...(request ? { request } : {}),
    capabilities: {},
  }
}

function chatInput() {
  return {
    messages: [{
      parts: [{ text: "hello", type: "text" }],
      role: "user",
    }],
  }
}

function githubSignature(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

function stripeSignature(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
}

function stripeRequest(header: string, body = "{\"id\":\"evt_1\"}") {
  return new Request("https://example.com", { body, headers: { "x-signature": header }, method: "POST" })
}

function stripeRegistration(signature: "stripe-sha256" | { preset: "stripe-sha256", toleranceSeconds?: number } = "stripe-sha256") {
  return [{ id: "productlane", provider: "productlane", secretHeader: "x-signature", secretToken: "secret-token", signature }]
}

describe("agent webhook verification", () => {
  it("allows chat webhook trigger invocation when the secret header matches", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { secretToken: "secret-token" },
        },
      })],
      driver: { run: invoked, },
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com", {
      headers: { "x-telegram-bot-api-secret-token": "secret-token" },
    })), "chat.message", chatInput())).resolves.toBe("ok")
    expect(invoked).toHaveBeenCalledTimes(1)
  })

  it("rejects chat webhook trigger invocation when the secret header does not match", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { secretToken: "secret-token" },
        },
      })],
      driver: { run: invoked, },
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com", {
      headers: { "x-telegram-bot-api-secret-token": "wrong-token" },
    })), "chat.message", chatInput()))
      .rejects
      .toMatchObject({ message: "[vitehub] Webhook secret verification failed.", statusCode: 401 })
    expect(invoked).not.toHaveBeenCalled()
  })

  it("rejects webhook trigger invocation when a configured secret header is missing", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { secretToken: "secret-token" },
        },
      })],
      driver: { run: invoked, },
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com")), "chat.message", chatInput()))
      .rejects
      .toMatchObject({
        message: "[vitehub] Webhook secret header \"x-telegram-bot-api-secret-token\" is required.",
        statusCode: 401,
      })
    expect(invoked).not.toHaveBeenCalled()
  })

  it("resolves chat webhook secret tokens from runtime context", async () => {
    const invoked = vi.fn(() => "ok")
    const secretToken = vi.fn(context => String(context.cloudflare?.env?.TELEGRAM_WEBHOOK_SECRET_TOKEN))
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { secretToken },
        },
      })],
      driver: { run: invoked, },
    })

    const request = new Request("https://example.com", {
      headers: { "x-telegram-bot-api-secret-token": "secret-token" },
    })
    await expect(runAgentTrigger(agent, {
      ...runtime(request),
      cloudflare: {
        env: {
          TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret-token",
        },
      },
    }, "chat.message", chatInput())).resolves.toBe("ok")

    expect(secretToken).toHaveBeenCalledWith(expect.objectContaining({
      cloudflare: {
        env: {
          TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret-token",
        },
      },
    }))
    expect(invoked).toHaveBeenCalledTimes(1)
  })

  it("fails closed when a targeted registration has no configured secret token", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { path: "/webhooks/telegram" },
        },
      })],
      driver: { run: invoked, },
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com", {
      headers: { "x-telegram-bot-api-secret-token": "provided-token" },
    })), "chat.message", chatInput()))
      .rejects
      .toMatchObject({
        message: "[vitehub] Webhook registration \"telegram\" declares secretHeader \"x-telegram-bot-api-secret-token\" but no secretToken is configured. Verification requires secretToken from Server Env; secretToken: false explicitly disables verification.",
        statusCode: 401,
      })
    expect(invoked).not.toHaveBeenCalled()
  })

  it("fails closed when a generated route requires a secret header but the registration has only a secret token", async () => {
    await expect(verifyAgentWebhookRequest([{
      id: "custom",
      provider: "custom",
      secretToken: "secret-token",
    }], new Request("https://example.com", { method: "POST" }), runtime(), { requireSecretHeader: true }))
      .rejects
      .toMatchObject({
        message: "[vitehub] Webhook registration \"custom\" declares secretToken but no secretHeader is configured. Verification requires secretHeader; secretToken: false explicitly disables verification.",
        statusCode: 401,
      })
  })

  it("provides capabilities when verification context is omitted", async () => {
    const secretToken = vi.fn(context => context.capabilities.webhook?.value)
    await expect(verifyAgentWebhookRequest([{
      id: "custom",
      provider: "custom",
      secretHeader: "x-webhook-secret",
      secretToken,
    }], new Request("https://example.com", {
      headers: { "x-webhook-secret": "provided-token" },
      method: "POST",
    }))).rejects.toMatchObject({ statusCode: 401 })

    expect(secretToken).toHaveBeenCalledWith(expect.objectContaining({ capabilities: {} }))
  })

  it("supports custom signature verifiers with the raw request body", async () => {
    const verify = vi.fn(({ header, rawBody, request, secret }) =>
      header === "signed" && new TextDecoder().decode(rawBody) === "payload" && request.method === "POST" && secret === "secret-token")

    const result = await verifyAgentWebhookRequest([{
      id: "custom",
      provider: "custom",
      secretHeader: "x-signature",
      secretToken: "secret-token",
      signature: { verify },
    }], new Request("https://example.com", {
      method: "POST",
      headers: { "x-signature": "signed" },
      body: "payload",
    }))

    expect(result.verified).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it("reads a request body once for multiple signature verifiers", async () => {
    const seen: string[] = []
    const verify = vi.fn(({ rawBody }: { rawBody: Uint8Array }) => {
      seen.push(new TextDecoder().decode(rawBody))
      if (seen.length === 1) rawBody[0] = 0x78
      return false
    })
    const request = new Request("https://example.com", {
      body: "payload",
      headers: { "x-first-signature": "first", "x-second-signature": "second" },
      method: "POST",
    })
    const clone = vi.spyOn(request, "clone")

    await expect(verifyAgentWebhookRequest([
      {
        id: "first",
        provider: "custom",
        secretHeader: "x-first-signature",
        secretToken: "secret-token",
        signature: { verify },
      },
      {
        id: "second",
        provider: "custom",
        secretHeader: "x-second-signature",
        secretToken: "secret-token",
        signature: { verify },
      },
    ], request)).rejects.toMatchObject({ statusCode: 401 })

    expect(clone).toHaveBeenCalledOnce()
    expect(seen).toEqual(["payload", "payload"])
  })

  it("allows explicit unverified webhook registrations", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { secretToken: false },
        },
      })],
      driver: { run: invoked, },
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com", {
      headers: { "x-telegram-bot-api-secret-token": "any-token" },
    })), "chat.message", chatInput())).resolves.toBe("ok")
    expect(invoked).toHaveBeenCalledTimes(1)
  })

  it("does not treat app requests without a declared secret header as webhook requests", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { path: "/webhooks/telegram" },
        },
      })],
      driver: { run: invoked, },
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com")), "chat.message", chatInput()))
      .resolves
      .toBe("ok")
    expect(invoked).toHaveBeenCalledTimes(1)
  })

  it("does not enforce webhook verification for programmatic invocations", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { path: "/webhooks/telegram" },
        },
      })],
      driver: { run: invoked, },
    })

    await expect(runAgentTrigger(agent, runtime(), "chat.message", chatInput())).resolves.toBe("ok")
    expect(invoked).toHaveBeenCalledTimes(1)
  })

  it("verifies GitHub delivery signatures", async () => {
    const { github } = await import("../src/channels.ts")
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: () => ({ input: { prompt: "github" } }),
            },
          },
          webhooks: { secretToken: "secret-token" },
        }),
      },
      driver: { run: invoked, },
    })
    const body = JSON.stringify({ action: "opened" })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com", {
      body,
      headers: { "x-hub-signature-256": githubSignature("secret-token", body) },
      method: "POST",
    })), "github.webhook", {})).resolves.toBe("ok")
    expect(invoked).toHaveBeenCalledTimes(1)
  })

  it("rejects invalid GitHub delivery signatures", async () => {
    const { github } = await import("../src/channels.ts")
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              invoke: () => ({ input: { prompt: "github" } }),
            },
          },
          webhooks: { secretToken: "secret-token" },
        }),
      },
      driver: { run: invoked, },
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com", {
      body: JSON.stringify({ action: "opened" }),
      headers: { "x-hub-signature-256": "sha256=wrong" },
      method: "POST",
    })), "github.webhook", {}))
      .rejects
      .toMatchObject({ message: "[vitehub] Webhook secret verification failed.", statusCode: 401 })
    expect(invoked).not.toHaveBeenCalled()
  })

  it("verifies stripe-sha256 timestamped signatures", async () => {
    const body = "{\"id\":\"evt_1\"}"
    await expect(verifyAgentWebhookRequest(stripeRegistration(), stripeRequest(stripeSignature("secret-token", body), body)))
      .resolves.toMatchObject({ verified: true })
  })

  it("accepts any matching stripe-sha256 v1 signature", async () => {
    const body = "{\"id\":\"evt_1\"}"
    const timestamp = Math.floor(Date.now() / 1000)
    const valid = stripeSignature("secret-token", body, timestamp).split(",")[1]
    await expect(verifyAgentWebhookRequest(stripeRegistration(), stripeRequest(`t=${timestamp},v1=${"0".repeat(64)},${valid}`, body)))
      .resolves.toMatchObject({ verified: true })
  })

  it("bounds stripe-sha256 signature candidates", async () => {
    const body = "{\"id\":\"evt_1\"}"
    const timestamp = Math.floor(Date.now() / 1000)
    const candidates = Array.from({ length: 33 }, () => `v1=${"0".repeat(64)}`).join(",")
    await expect(verifyAgentWebhookRequest(stripeRegistration(), stripeRequest(`t=${timestamp},${candidates}`, body)))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it("rejects stale stripe-sha256 timestamps", async () => {
    const body = "{\"id\":\"evt_1\"}"
    const stale = stripeSignature("secret-token", body, Math.floor(Date.now() / 1000) - 301)
    await expect(verifyAgentWebhookRequest(stripeRegistration(), stripeRequest(stale, body)))
      .rejects.toMatchObject({ message: "[vitehub] Webhook secret verification failed.", statusCode: 401 })
  })

  it("applies a configured stripe-sha256 tolerance", async () => {
    const body = "{\"id\":\"evt_1\"}"
    const older = stripeSignature("secret-token", body, Math.floor(Date.now() / 1000) - 500)
    await expect(verifyAgentWebhookRequest(stripeRegistration({ preset: "stripe-sha256", toleranceSeconds: 600 }), stripeRequest(older, body)))
      .resolves.toMatchObject({ verified: true })
    await expect(verifyAgentWebhookRequest(stripeRegistration({ preset: "stripe-sha256", toleranceSeconds: 60 }), stripeRequest(older, body)))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it("uses integer-second maximum-age semantics", async () => {
    const body = "{\"id\":\"evt_1\"}"
    const now = Math.floor(Date.now() / 1000)
    await expect(verifyAgentWebhookRequest(stripeRegistration({ preset: "stripe-sha256", toleranceSeconds: 0 }), stripeRequest(stripeSignature("secret-token", body, now), body)))
      .resolves.toMatchObject({ verified: true })
    await expect(verifyAgentWebhookRequest(stripeRegistration({ preset: "stripe-sha256", toleranceSeconds: 0 }), stripeRequest(stripeSignature("secret-token", body, now + 60), body)))
      .resolves.toMatchObject({ verified: true })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects invalid signature tolerance %s", async toleranceSeconds => {
    const body = "{\"id\":\"evt_1\"}"
    const header = stripeSignature("secret-token", body)
    await expect(verifyAgentWebhookRequest(stripeRegistration({ preset: "stripe-sha256", toleranceSeconds }), stripeRequest(header, body)))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it("rejects wrong stripe-sha256 signatures", async () => {
    const body = "{\"id\":\"evt_1\"}"
    await expect(verifyAgentWebhookRequest(stripeRegistration(), stripeRequest(stripeSignature("other-secret", body), body)))
      .rejects.toMatchObject({ statusCode: 401 })
    await expect(verifyAgentWebhookRequest(stripeRegistration(), stripeRequest(stripeSignature("secret-token", body), "{\"id\":\"evt_2\"}")))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it.each([
    ["an empty header", ""],
    ["a missing timestamp", `v1=${"0".repeat(64)}`],
    ["a missing v1 signature", `t=${Math.floor(Date.now() / 1000)}`],
    ["a non-numeric timestamp", `t=soon,v1=${"0".repeat(64)}`],
    ["a GitHub-style header", `sha256=${"0".repeat(64)}`],
    ["an invalid-length signature", `t=${Math.floor(Date.now() / 1000)},v1=bad`],
  ])("rejects stripe-sha256 headers with %s", async (_label, header) => {
    await expect(verifyAgentWebhookRequest(stripeRegistration(), stripeRequest(header)))
      .rejects.toMatchObject({ statusCode: 401 })
  })
})

it.each(["gitlab", "forgejo"] as const)("verifies the %s Channel through the client", async kind => {
  const { gitlab, forgejo } = await import("../src/channels.ts")
  const { signDelivery } = await import("forges/testing")
  const channel = kind === "gitlab" ? gitlab({ webhookSecret: "secret", pullRequest: true }) : forgejo({ webhookSecret: "secret", pullRequest: true })
  const factory = (options: ForgejoChannelOptions) => kind === "gitlab" ? gitlab(options) : forgejo(options)
  expect(factory({ webhooks: false }).webhooks).toBe(false)
  const configured = factory({ webhookSecret: "secret", webhooks: [{ id: "first", secretToken: false, signature: { verify: () => true } }, { id: "second" }] }).webhooks
  expect(configured).toEqual([
    expect.objectContaining({ id: "first", secretToken: expect.any(Function), signature: { verify: expect.any(Function) } }),
    expect.objectContaining({ id: "second", secretToken: expect.any(Function), signature: { verify: expect.any(Function) } }),
  ])
  const agent = defineAgent({ channels: { host: channel }, driver: { run: () => "ok" } })
  const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
  const triggers = await resolveAgentTriggers(agent, { ...runtime(), runtimeConfig: {} })
  const registrations = triggers["host.webhook"]!.webhooks!
  const body = JSON.stringify(kind === "gitlab" ? { object_kind: "note" } : { action: "created" })
  const headers: Record<string, string> = kind === "gitlab" ? { "x-gitlab-event": "Note Hook" } : { "x-forgejo-event": "issue_comment" }
  const signed = await signDelivery(kind, body, "secret", headers)
  await expect(verifyAgentWebhookRequest(registrations, new Request("https://agent.test", { method: "POST", body, headers: signed }), runtime())).resolves.toMatchObject({ verified: true })
  const wrong = await signDelivery(kind, body, "wrong", headers)
  await expect(verifyAgentWebhookRequest(registrations, new Request("https://agent.test", { method: "POST", body, headers: wrong }), runtime())).rejects.toMatchObject({ statusCode: 401 })
})
