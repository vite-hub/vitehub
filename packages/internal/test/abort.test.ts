import { describe, expect, it, vi } from "vitest"

import { abortable } from "../src/abort.ts"

describe("abortable", () => {
  it("rejects with the caller's abort reason without waiting for the task", async () => {
    const controller = new AbortController()
    const reason = new Error("stop")
    const result = abortable(controller.signal, "interrupted", () => new Promise<never>(() => {})).catch(error => error)
    controller.abort(reason)
    await expect(result).resolves.toBe(reason)
  })

  it("does not run the task when the signal is already aborted", async () => {
    const reason = new Error("stopped before start")
    const task = vi.fn(async () => "value")
    await expect(abortable(AbortSignal.abort(reason), "interrupted", task)).rejects.toBe(reason)
    expect(task).not.toHaveBeenCalled()
  })

  it("returns values and failures by identity", async () => {
    const failure = new Error("failure")
    const thrown = new Error("thrown")
    await expect(abortable(undefined, "interrupted", () => 42)).resolves.toBe(42)
    await expect(abortable(new AbortController().signal, "interrupted", () => Promise.reject(failure))).rejects.toBe(failure)
    await expect(abortable(undefined, "interrupted", () => { throw thrown })).rejects.toBe(thrown)
  })

  it("removes its abort listener when the task settles", async () => {
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener")
    await abortable(controller.signal, "interrupted", async () => "done")
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function))
  })
})
