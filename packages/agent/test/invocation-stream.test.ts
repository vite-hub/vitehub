import { describe, expect, it, vi } from "vitest"

import { LlmGateRejectedError } from "../src/capabilities/llm-gate.ts"
import { RateLimitRejectedError } from "../src/capabilities/rate-limit.ts"
import { createAgentInvocationStreamResponse, readAgentInvocationStream } from "../src/invocation-stream.ts"
import { writeResponse } from "../src/vite/invocation-stream-endpoint.ts"

import type { ServerResponse } from "node:http"

describe("Agent Invocation Stream", () => {
  it("closes timed-out streams even when the run does not settle", async () => {
    let aborted = false
    const response = createAgentInvocationStreamResponse(async (_emit, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true
      })
      await new Promise(() => {})
    }, { timeout: 10 })

    const text = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("stream stayed open")), 100)),
    ])

    expect(text.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { code: "INTERNAL", error: "Agent Invocation Stream failed.", type: "error" },
      { type: "done" },
    ])
    expect(aborted).toBe(true)
  })

  it("treats AbortError from cancellation aborts as cleanup", async () => {
    const NativeAbortController = globalThis.AbortController

    class ThrowingAbortController extends NativeAbortController {
      override abort(reason?: unknown): void {
        super.abort(reason)
        throw new DOMException("aborted", "AbortError")
      }
    }

    Object.defineProperty(globalThis, "AbortController", {
      configurable: true,
      value: ThrowingAbortController,
      writable: true,
    })
    try {
      const response = createAgentInvocationStreamResponse(async () => {
        await new Promise(() => {})
      })

      await expect(response.body!.cancel()).resolves.toBeUndefined()
    }
    finally {
      Object.defineProperty(globalThis, "AbortController", {
        configurable: true,
        value: NativeAbortController,
        writable: true,
      })
    }
  })

  it("only treats closed-response AbortError body failures as cleanup", async () => {
    const destroy = vi.fn()
    const res = {
      destroy,
      end: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      setHeader: vi.fn(),
      statusCode: 200,
      write: vi.fn(() => true),
    } as unknown as ServerResponse

    await writeResponse(res, new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException("aborted", "AbortError")
      },
    })))

    expect(destroy).toHaveBeenCalledWith(expect.any(DOMException))
    destroy.mockClear()

    let close: (() => void) | undefined
    const closedRes = {
      destroy,
      end: vi.fn(),
      off: vi.fn(),
      once: vi.fn((_event: string, callback: () => void) => {
        close = callback
      }),
      setHeader: vi.fn(),
      statusCode: 200,
      write: vi.fn(() => true),
    } as unknown as ServerResponse

    await writeResponse(closedRes, new Response(new ReadableStream<Uint8Array>({
      pull() {
        close?.()
        throw new DOMException("aborted", "AbortError")
      },
    })))

    expect(destroy).not.toHaveBeenCalled()
  })

  it("closes with an error when event serialization fails", async () => {
    let abortReason: unknown
    const response = createAgentInvocationStreamResponse(async (emit, signal) => {
      signal.addEventListener("abort", () => {
        abortReason = signal.reason
      })
      emit({ data: 1n, type: "data" } as never)
    })

    const events = []
    for await (const event of readAgentInvocationStream(response.body!)) {
      events.push(event)
    }

    expect(events).toEqual([
      { code: "INTERNAL", error: "Agent Invocation Stream event could not be serialized.", type: "error" },
      { type: "done" },
    ])
    expect(abortReason).toBeInstanceOf(TypeError)
    expect((abortReason as Error).message).toContain("BigInt")
  })

  it("redacts unowned thrown values as stream errors", async () => {
    const response = createAgentInvocationStreamResponse(async () => {
      throw { code: "delivery_preview_failed", status: 422 }
    })

    const events = []
    for await (const event of readAgentInvocationStream(response.body!)) {
      events.push(event)
    }

    expect(events).toEqual([
      { code: "INTERNAL", error: "Agent Invocation Stream failed.", type: "error" },
      { type: "done" },
    ])
  })

  it("emits allowlisted rate-limit and gate failures without changing event order", async () => {
    const failures = [
      [new RateLimitRejectedError("rate-limit", { retryAfter: 30 } as never, "private provider response"), {
        code: "RATE_LIMIT_REJECTED",
        details: { capability: "rate-limit", retryAfter: 30 },
        error: "Rate limit exceeded. Try again later.",
        type: "error",
      }],
      [new LlmGateRejectedError("safety-gate", {
        allowed: false,
        category: "unsafe",
        reason: "private prompt",
      }, "private classification"), {
        code: "LLM_GATE_REJECTED",
        details: { capability: "safety-gate", category: "unsafe" },
        error: "Agent request was rejected.",
        type: "error",
      }],
    ] as const

    for (const [failure, expected] of failures) {
      const response = createAgentInvocationStreamResponse(async (emit) => {
        emit({ label: "before", type: "data" } as never)
        throw failure
      })
      const events = []
      for await (const event of readAgentInvocationStream(response.body!)) events.push(event)

      expect(events).toEqual([
        { label: "before", type: "data" },
        expected,
        { type: "done" },
      ])
    }
  })
})
