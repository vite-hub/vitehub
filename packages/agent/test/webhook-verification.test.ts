import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { defineChatCapability as chat } from "../src/chat-trigger.ts"
import { defineAgent, runAgentTrigger, verifyAgentWebhookRequest } from "../src/index.ts"

function runtime(request?: Request) {
  return {
    ...(request ? { request } : {}),
    capabilities: {},
    memo: vi.fn(),
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
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
})
