import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"

import { describe, expect, it, vi } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"
import { createAgentInvocationStreamResponse, readAgentInvocationStream } from "../src/invocation-stream.ts"
import { writeResponse } from "../src/vite/invocation-stream-endpoint.ts"

describe("Agent Invocation Stream", () => {
  it("cancels the invocation when its reader stops early", async () => {
    let signal: AbortSignal | undefined
    const response = createAgentInvocationStreamResponse(async (emit, runSignal) => {
      signal = runSignal
      emit({ text: "first", type: "text-delta" })
      await new Promise<void>(resolve => runSignal.addEventListener("abort", () => resolve(), { once: true }))
    })

    for await (const event of readAgentInvocationStream(response.body!)) {
      expect(event).toEqual({ text: "first", type: "text-delta" })
      break
    }

    expect(signal?.aborted).toBe(true)
  })

  it("preserves parser errors when stream cancellation also fails", async () => {
    const cleanupFailure = new Error("cleanup failed")
    const cancel = vi.fn(async () => { throw cleanupFailure })
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not json\n"))
      },
    })

    let failure: unknown
    try {
      for await (const _event of readAgentInvocationStream(body)) {}
    }
    catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(SyntaxError)
    expect(failure).not.toBe(cleanupFailure)
    expect(cancel).toHaveBeenCalledWith(failure)
  })

  it("rejects stream lines without an event discriminator", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("null\n"))
      },
    })

    await expect(async () => {
      for await (const _event of readAgentInvocationStream(body)) {}
    }).rejects.toThrow("Invalid Agent Invocation Stream event.")
  })

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
      { code: "INTERNAL", error: "Agent Invocation Stream timed out after 10ms of inactivity.", type: "error" },
      { type: "done" },
    ])
    expect(aborted).toBe(true)
  })

  it("keeps active streams open beyond the inactivity timeout", async () => {
    vi.useFakeTimers()
    try {
      const response = createAgentInvocationStreamResponse(async (emit) => {
        for (const text of ["first", "second", "third"]) {
          await new Promise(resolve => setTimeout(resolve, 20))
          emit({ text, type: "text-delta" })
        }
      }, { timeout: 30 })

      const text = response.text()
      await vi.advanceTimersByTimeAsync(60)

      await expect(text).resolves.toBe([
        JSON.stringify({ text: "first", type: "text-delta" }),
        JSON.stringify({ text: "second", type: "text-delta" }),
        JSON.stringify({ text: "third", type: "text-delta" }),
        JSON.stringify({ type: "done" }),
        "",
      ].join("\n"))
    }
    finally {
      vi.useRealTimers()
    }
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
    const res = new ServerResponse(new IncomingMessage(new Socket()))
    const destroy = vi.spyOn(res, "destroy").mockImplementation(() => res)
    vi.spyOn(res, "end").mockImplementation(() => res)
    vi.spyOn(res, "write").mockImplementation(() => true)

    await writeResponse(res, new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException("aborted", "AbortError")
      },
    })))

    expect(destroy).toHaveBeenCalledWith(expect.any(DOMException))
    destroy.mockClear()

    const closedRes = new ServerResponse(new IncomingMessage(new Socket()))
    const closedDestroy = vi.spyOn(closedRes, "destroy").mockImplementation(() => closedRes)
    vi.spyOn(closedRes, "end").mockImplementation(() => closedRes)
    vi.spyOn(closedRes, "write").mockImplementation(() => true)

    await writeResponse(closedRes, new Response(new ReadableStream<Uint8Array>({
      pull() {
        closedRes.emit("close")
        throw new DOMException("aborted", "AbortError")
      },
    })))

    expect(closedDestroy).not.toHaveBeenCalled()
  })

  it("closes with an error when event serialization fails", async () => {
    const response = createAgentInvocationStreamResponse(async (emit) => {
      // SAFETY: This intentionally violates the serializable data contract to exercise response error handling.
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
