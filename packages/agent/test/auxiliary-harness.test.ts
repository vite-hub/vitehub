import { describe, expect, it, vi } from "vitest"

import { quietExpectedAuxiliaryHarnessCancellation } from "../src/internal/auxiliary-harness.ts"

function wrappedTurn(
  run: (options: { abortSignal?: AbortSignal; emit: (event: unknown) => void }) => {
    done: Promise<void>
  },
) {
  const harness = quietExpectedAuxiliaryHarnessCancellation({
    async doStart() {
      return { doPromptTurn: run }
    },
  }) as { doStart: () => Promise<{ doPromptTurn: typeof run }> }
  return harness.doStart()
}

describe("auxiliary Harness cancellation", () => {
  it.each([
    ["AbortError", "identity", (reason: DOMException) => reason],
    ["TimeoutError", "matching shape", (reason: DOMException) => ({ message: reason.message, name: reason.name })],
  ])("suppresses an aborted %s by %s", async (name, _match, emittedError) => {
    const controller = new AbortController()
    const reason = new DOMException("The auxiliary turn stopped.", name)
    const error = emittedError(reason)
    const emit = vi.fn()
    const session = await wrappedTurn((options) => {
      controller.abort(reason)
      options.emit({ error, type: "error" })
      return { done: Promise.reject(error) }
    })

    const control = await session.doPromptTurn({ abortSignal: controller.signal, emit })

    await expect(control.done).resolves.toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it("suppresses an identical custom abort reason", async () => {
    const controller = new AbortController()
    const reason = new Error("The auxiliary turn stopped.")
    const emit = vi.fn()
    const session = await wrappedTurn((options) => {
      controller.abort(reason)
      options.emit({ error: reason, type: "error" })
      return { done: Promise.reject(reason) }
    })

    const control = await session.doPromptTurn({ abortSignal: controller.signal, emit })

    await expect(control.done).resolves.toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it("preserves a TimeoutError when the signal was not aborted", async () => {
    const controller = new AbortController()
    const error = new DOMException("The operation timed out.", "TimeoutError")
    const emit = vi.fn()
    const session = await wrappedTurn((options) => {
      options.emit({ error, type: "error" })
      return { done: Promise.reject(error) }
    })

    const control = await session.doPromptTurn({ abortSignal: controller.signal, emit })

    await expect(control.done).rejects.toBe(error)
    expect(emit).toHaveBeenCalledWith({ error, type: "error" })
  })

  it("preserves a provider error after the signal was aborted", async () => {
    const controller = new AbortController()
    const reason = new DOMException("The operation timed out.", "TimeoutError")
    const error = new Error("Provider connection failed.")
    const emit = vi.fn()
    const session = await wrappedTurn((options) => {
      controller.abort(reason)
      options.emit({ error, type: "error" })
      return { done: Promise.reject(error) }
    })

    const control = await session.doPromptTurn({ abortSignal: controller.signal, emit })

    await expect(control.done).rejects.toBe(error)
    expect(emit).toHaveBeenCalledWith({ error, type: "error" })
  })

  it("preserves a mismatched cancellation after the signal was aborted", async () => {
    const controller = new AbortController()
    controller.abort(new DOMException("Auxiliary timeout.", "TimeoutError"))
    const error = new DOMException("Provider timeout.", "TimeoutError")
    const emit = vi.fn()
    const session = await wrappedTurn((options) => {
      options.emit({ error, type: "error" })
      return { done: Promise.reject(error) }
    })

    const control = await session.doPromptTurn({ abortSignal: controller.signal, emit })

    await expect(control.done).rejects.toBe(error)
    expect(emit).toHaveBeenCalledWith({ error, type: "error" })
  })
})
