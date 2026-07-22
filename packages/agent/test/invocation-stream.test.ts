import { describe, expect, it, vi } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"
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
    const response = createAgentInvocationStreamResponse(async (emit) => {
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
  })

  it("redacts non-Error thrown values as stream errors", async () => {
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

  it("preserves allowlisted stream details without requiring capability metadata", async () => {
    const failures = [
      [new ViteHubError("RATE_LIMIT_REJECTED", "private limiter response", { details: { retryAfter: 15 } }), {
        code: "RATE_LIMIT_REJECTED",
        details: { retryAfter: 15 },
        error: "Rate limit exceeded. Try again later.",
      }],
      [new ViteHubError("LLM_GATE_REJECTED", "private classifier response", { details: { category: "unsafe" } }), {
        code: "LLM_GATE_REJECTED",
        details: { category: "unsafe" },
        error: "Agent request was rejected.",
      }],
    ] as const

    for (const [failure, expected] of failures) {
      const response = createAgentInvocationStreamResponse(async () => { throw failure })
      const events = []
      for await (const event of readAgentInvocationStream(response.body!)) events.push(event)
      expect(events).toEqual([{ ...expected, type: "error" }, { type: "done" }])
    }
  })
})
