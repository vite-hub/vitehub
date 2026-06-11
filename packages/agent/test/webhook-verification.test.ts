import { describe, expect, it, vi } from "vitest"

import { chat } from "../src/capabilities.ts"
import { defineAgent, runAgentTrigger } from "../src/index.ts"

function runtime(request?: Request) {
  return {
    ...(request ? { request } : {}),
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

describe("agent webhook verification", () => {
  it("allows chat webhook trigger invocation when the secret header matches", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { secretToken: "secret-token" },
        },
      })],
      run: invoked,
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
      run: invoked,
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com", {
      headers: { "x-telegram-bot-api-secret-token": "wrong-token" },
    })), "chat.message", chatInput()))
      .rejects
      .toMatchObject({ message: "[vitehub] Webhook secret verification failed.", statusCode: 401 })
    expect(invoked).not.toHaveBeenCalled()
  })

  it("fails closed when a targeted registration has no configured secret token", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { path: "/webhooks/telegram" },
        },
      })],
      run: invoked,
    })

    await expect(runAgentTrigger(agent, runtime(new Request("https://example.com", {
      headers: { "x-telegram-bot-api-secret-token": "provided-token" },
    })), "chat.message", chatInput()))
      .rejects
      .toMatchObject({
        message: "[vitehub] Webhook registration \"telegram\" declares secretHeader \"x-telegram-bot-api-secret-token\" but no secretToken is configured. Set secretToken (from Server Env) or secretToken: false to explicitly disable verification.",
        statusCode: 401,
      })
    expect(invoked).not.toHaveBeenCalled()
  })

  it("allows explicit unverified webhook registrations", async () => {
    const invoked = vi.fn(() => "ok")
    const agent = defineAgent({
      capabilities: [chat({
        webhooks: {
          telegram: { secretToken: false },
        },
      })],
      run: invoked,
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
      run: invoked,
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
      run: invoked,
    })

    await expect(runAgentTrigger(agent, runtime(), "chat.message", chatInput())).resolves.toBe("ok")
    expect(invoked).toHaveBeenCalledTimes(1)
  })
})
