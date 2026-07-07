import { describe, expect, it, vi } from "vitest"

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
      { error: "Agent Invocation Stream timed out after 10ms.", type: "error" },
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
      { error: "Do not know how to serialize a BigInt", type: "error" },
      { type: "done" },
    ])
  })

  it("formats non-Error thrown values as stream errors", async () => {
    const response = createAgentInvocationStreamResponse(async () => {
      throw { code: "delivery_preview_failed", status: 422 }
    })

    const events = []
    for await (const event of readAgentInvocationStream(response.body!)) {
      events.push(event)
    }

    expect(events).toEqual([
      { error: `{"code":"delivery_preview_failed","status":422}`, type: "error" },
      { type: "done" },
    ])
  })
})
