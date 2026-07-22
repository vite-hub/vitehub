import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vite-hub/agent"
import { ViteHubError } from "@vite-hub/runtime"
import { createRateLimiter } from "@vite-hub/rate-limit"
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"
import {
  rateLimit,
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

function limiter(limit = 1, window: "1s" | "1m" = "1m") {
  return createRateLimiter({
    driver: memoryRateLimitDriver(),
    limit,
    window,
  })
}

describe("rateLimit capability", () => {
  it("rejects before the Agent Invocation when an identity exhausts its limiter", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const run = vi.fn((context: { context: { get: (id: string) => unknown } }) => context.context.get("rate-limit"))
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: () => "user_1",
          limiter: limiter(2),
        }),
      ],
      driver: { run },
    })

    await expect(runAgent(agent, runtime(), {
      messages: [createMessage({ role: "user", text: "first" })],
    })).resolves.toMatchObject({
      allowed: true,
      identity: "user_1",
      limit: 2,
      remaining: 1,
      used: 1,
      windowMs: 60_000,
    })
    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
      used: 2,
    })
    await expect(runAgent(agent, runtime(), {})).rejects.toMatchObject({
      code: "RATE_LIMIT_REJECTED",
      details: { capabilityId: "rate-limit", reason: "limited", retryAfter: expect.any(Number) },
      name: "ViteHubError",
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("keeps Agent identity and scope resolution above the portable limiter", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const sharedLimiter = limiter()
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          id: "customer-quota",
          identity: "invoker",
          limiter: sharedLimiter,
          scope: context => `customer:${context.invoker.meta?.customer}`,
        }),
      ],
      driver: { run: context => context.context.get("customer-quota") },
    })

    await expect(runAgent(agent, runtime(), {
      context: { invoker: { id: "user_1", kind: "chat", meta: { customer: "acme" } } },
    })).resolves.toMatchObject({
      capabilityId: "customer-quota",
      identity: "chat:user_1",
      identitySource: "invoker",
      scope: "customer:acme",
    })
    await expect(runAgent(agent, runtime(), {
      context: { invoker: { id: "user_1", kind: "inspection", meta: { customer: "acme" } } },
    })).resolves.toMatchObject({ identity: "inspection:user_1" })
    await expect(runAgent(agent, runtime(), {
      context: { invoker: { id: "user_1", kind: "chat", meta: { customer: "acme" } } },
    })).rejects.toBeInstanceOf(ViteHubError)
  })

  it("resolves a user's preferred limiter from Agent Invocation Context", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const free = limiter(1)
    const pro = limiter(2)
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: "invoker",
          limiter: context => context.invoker.meta?.tier === "pro" ? pro : free,
        }),
      ],
      driver: { run: context => context.context.get("rate-limit") },
    })

    await expect(runAgent(agent, runtime(), {
      context: { invoker: { id: "user_1", meta: { tier: "pro" } } },
    })).resolves.toMatchObject({ limit: 2, remaining: 1 })
    await expect(runAgent(agent, runtime(), {
      context: { invoker: { id: "user_1", meta: { tier: "pro" } } },
    })).resolves.toMatchObject({ limit: 2, remaining: 0 })
    await expect(runAgent(agent, runtime(), {
      context: { invoker: { id: "user_2" } },
    })).resolves.toMatchObject({ limit: 1, remaining: 0 })
    await expect(runAgent(agent, runtime(), {
      context: { invoker: { id: "user_2" } },
    })).rejects.toBeInstanceOf(ViteHubError)
  })

  it("runs callbacks with the Agent decision and resolved limiter", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const onAllowed = vi.fn()
    const onDecision = vi.fn()
    const onRejected = vi.fn()
    const resolvedLimiter = limiter()
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: () => "user_1",
          limiter: resolvedLimiter,
          onAllowed,
          onDecision,
          onRejected,
        }),
      ],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toBe("ok")
    await expect(runAgent(agent, runtime(), {})).rejects.toBeInstanceOf(ViteHubError)

    expect(onDecision).toHaveBeenCalledTimes(2)
    expect(onAllowed).toHaveBeenCalledTimes(1)
    expect(onRejected).toHaveBeenCalledTimes(1)
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({
      decision: expect.objectContaining({ allowed: false, identity: "user_1", used: 1 }),
      limiter: resolvedLimiter,
    }))
  })

  it("uses only explicitly trusted request headers for IP identity", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const request = new Request("https://example.com/api/agent", {
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
    })
    const trustedAgent = defineAgent({
      capabilities: [
        rateLimit({
          identity: "ip",
          limiter: limiter(),
          trustedIpHeaders: ["x-forwarded-for"],
        }),
      ],
      driver: { run: context => context.context.get("rate-limit") },
    })
    const untrustedAgent = defineAgent({
      capabilities: [
        rateLimit({
          identity: "ip",
          limiter: limiter(),
        }),
      ],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(trustedAgent, runtime({ request }), {})).resolves.toMatchObject({
      identity: "203.0.113.10",
      identitySource: "ip",
    })
    await expect(runAgent(untrustedAgent, runtime({ request }), {})).rejects.toThrow("requires trustedIpHeaders")
  })

  it("requires stable Agent Run metadata for run identity", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [
        rateLimit({
          identity: "run",
          limiter: limiter(),
        }),
      ],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, runtime({ run: { runId: "run_1" } }), {})).rejects.toThrow("could not resolve Agent Run metadata")
    await expect(runAgent(agent, runtime({ run: { runId: "run_2", threadId: "thread_1" } }), {})).resolves.toBe("ok")
  })

  it("preserves retry metadata on HTTP error responses", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const agent = defineAgent({
        capabilities: [
          rateLimit({
            identity: () => "user_1",
            limiter: limiter(),
            message: decision => `Try again in ${decision.retryAfter}s.`,
          }),
        ],
        driver: { run: () => "ok" },
      })

      await expect(runAgent(agent, runtime(), {})).resolves.toBe("ok")
      const error = await runAgent(agent, runtime(), {}).catch(error => error)
      const response = toHttpErrorResponse(error)

      expect(response?.status).toBe(429)
      expect(response?.headers.get("retry-after")).toBe("60")
      expect(response?.headers.get("x-retry-after")).toBe("60")
      await expect(response?.json()).resolves.toEqual({
        code: "RATE_LIMIT_REJECTED",
        details: { capability: "rate-limit", retryAfter: 60 },
        error: "Rate limit exceeded. Try again later.",
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("omits retry headers when a provider cannot report reset metadata", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const providerLimiter = {
      capabilities: {
        enforcement: "best-effort" as const,
        rejectedAttempts: "unknown" as const,
        scope: "global" as const,
      },
      policy: {
        enforcement: "best-effort" as const,
        failure: "deny" as const,
        limit: 1,
        window: "1m" as const,
        windowMs: 60_000,
      },
      consume: vi.fn(async () => ({ allowed: false, limit: 1, reason: "limited", windowMs: 60_000 } as const)),
    }
    const agent = defineAgent({
      capabilities: [rateLimit({ limiter: providerLimiter })],
      driver: { run: () => "ok" },
    })

    const error = await runAgent(agent, runtime(), {}).catch(error => error)
    const response = toHttpErrorResponse(error)
    expect(response?.status).toBe(429)
    expect(response?.headers.has("retry-after")).toBe(false)
  })

  it("preserves provider unavailability as a service error", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const cause = new Error("provider offline")
    const providerLimiter = {
      capabilities: {
        enforcement: "best-effort" as const,
        rejectedAttempts: "unknown" as const,
        scope: "global" as const,
      },
      policy: {
        enforcement: "best-effort" as const,
        failure: "deny" as const,
        limit: 1,
        window: "1m" as const,
        windowMs: 60_000,
      },
      consume: vi.fn(async () => ({ allowed: false, cause, limit: 1, reason: "unavailable", windowMs: 60_000 } as const)),
    }
    const agent = defineAgent({
      capabilities: [rateLimit({ limiter: providerLimiter })],
      driver: { run: () => "ok" },
    })

    const error = await runAgent(agent, runtime(), {}).catch(error => error)
    expect(error).toMatchObject({ cause, code: "RATE_LIMIT_UNAVAILABLE", name: "ViteHubError" })
    const response = toHttpErrorResponse(error)
    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toEqual({
      code: "RATE_LIMIT_UNAVAILABLE",
      details: { capability: "rate-limit" },
      error: "Rate limiting is unavailable.",
    })
  })
})
