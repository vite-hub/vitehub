import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vite-hub/agent"
import {
  memoryRateLimitStore,
  rateLimit,
  RateLimitRejectedError,
} from "../src/capabilities.ts"
import { toHttpErrorResponse } from "../src/http-error.ts"

import type { AgentRunMetadata, AgentRuntimeName } from "../src/index.ts"

const runtime = (options: {
  request?: Request
  run?: AgentRunMetadata
  runtime?: AgentRuntimeName
} = {}) => ({
  memo: vi.fn(),
  ...(options.request ? { request: options.request } : {}),
  ...(options.run ? { run: options.run } : {}),
  runtime: options.runtime || "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("rateLimit capability", () => {
  it("rejects before the agent run when an identity exhausts its window", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const run = vi.fn((context: { context: { get: (id: string) => unknown } }) => context.context.get("rate-limit"))
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: () => "user_1",
          limit: 2,
          window: "1m",
        }),
      ],
      run,
    })

    await expect(runAgent(agent, runtime(), {
      messages: [createMessage({ role: "user", text: "first" })],
    })).resolves.toMatchObject({
      allowed: true,
      identity: "user_1",
      limit: 2,
      remaining: 1,
    })
    await expect(runAgent(agent, runtime(), {
      messages: [createMessage({ role: "user", text: "second" })],
    })).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    })
    await expect(runAgent(agent, runtime(), {
      messages: [createMessage({ role: "user", text: "third" })],
    })).rejects.toMatchObject({
      decision: {
        allowed: false,
        identity: "user_1",
        limit: 2,
        remaining: 0,
      },
      name: "RateLimitRejectedError",
      retryAfter: expect.any(Number),
      statusCode: 429,
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("uses trusted chat input identity when configured for chat", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: "chat",
          limit: 1,
          window: "1m",
        }),
      ],
      run: () => "ok",
    })

    await expect(runAgent(agent, runtime(), {
      context: { "chat.identity": "user_1" },
    })).resolves.toBe("ok")
    await expect(runAgent(agent, runtime(), {
      context: { "chat.identity": "user_2" },
    })).resolves.toBe("ok")
    await expect(runAgent(agent, runtime(), {
      context: { "chat.identity": "user_1" },
    })).rejects.toBeInstanceOf(RateLimitRejectedError)
  })

  it("does not treat untrusted chat user context as Chat Identity", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: "chat",
          limit: 1,
          window: "1m",
        }),
      ],
      run: () => "ok",
    })

    await expect(runAgent(agent, runtime(), {
      context: { chat: { user: { id: "user_1" } } },
    })).rejects.toThrow("could not resolve a Chat Identity")
  })

  it("resets the memory store after the fixed window elapses", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const store = memoryRateLimitStore()
      const agent = defineAgent({
        capabilities: [
          rateLimit({
            identity: () => "user_1",
            limit: 1,
            store,
            window: "1s",
          }),
        ],
        run: () => "ok",
      })

      await expect(runAgent(agent, runtime(), {})).resolves.toBe("ok")
      await expect(runAgent(agent, runtime(), {})).rejects.toBeInstanceOf(RateLimitRejectedError)

      vi.setSystemTime(1_000)
      await expect(runAgent(agent, runtime(), {})).resolves.toBe("ok")
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("preserves retry headers on HTTP error responses", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const agent = defineAgent({
        capabilities: [
          rateLimit({
            identity: "ip",
            limit: 1,
            message: decision => `Try again in ${decision.retryAfter}s.`,
            trustedIpHeaders: ["x-forwarded-for"],
            window: "1m",
          }),
        ],
        run: () => "ok",
      })
      const request = new Request("https://example.com/api/agent", {
        headers: {
          "x-forwarded-for": "203.0.113.10",
        },
      })

      await expect(runAgent(agent, runtime({ request }), {})).resolves.toBe("ok")
      const error = await runAgent(agent, runtime({ request }), {}).catch(error => error)
      const response = toHttpErrorResponse(error)

      expect(response?.status).toBe(429)
      expect(response?.headers.get("retry-after")).toBe("60")
      expect(response?.headers.get("x-retry-after")).toBe("60")
      await expect(response?.json()).resolves.toEqual({ error: "Try again in 60s." })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("requires explicit trusted IP headers for IP identity", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: "ip",
          limit: 1,
          window: "1m",
        }),
      ],
      run: () => "ok",
    })

    await expect(runAgent(agent, runtime({
      request: new Request("https://example.com", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
    }), {})).rejects.toThrow("requires trustedIpHeaders")
  })

  it("requires an explicit store for hosted runtimes", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const withoutStore = defineAgent({
      capabilities: [
        rateLimit({
          identity: () => "user_1",
          limit: 1,
          window: "1m",
        }),
      ],
      run: () => "ok",
    })
    const withMemoryOptIn = defineAgent({
      capabilities: [
        rateLimit({
          identity: () => "user_1",
          limit: 1,
          store: "memory",
          window: "1m",
        }),
      ],
      run: () => "ok",
    })

    await expect(runAgent(withoutStore, runtime({ runtime: "vercel" }), {})).rejects.toThrow("requires an explicit store")
    await expect(runAgent(withMemoryOptIn, runtime({ runtime: "vercel" }), {})).resolves.toBe("ok")
  })

  it("requires stable run metadata for run identity", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: "run",
          limit: 1,
          window: "1m",
        }),
      ],
      run: () => "ok",
    })

    await expect(runAgent(agent, runtime({ run: { runId: "run_1" } }), {})).rejects.toThrow("could not resolve Agent Run metadata")
    await expect(runAgent(agent, runtime({ run: { runId: "run_2", threadId: "thread_1" } }), {})).resolves.toBe("ok")
  })
})
