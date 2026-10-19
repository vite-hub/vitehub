import { ViteHubError } from "@vite-hub/runtime"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { providerLaunchRetryDelaysMs, retryProviderLaunch } from "../src/internal/provider-launch-retry.ts"

function launchFailure(stderr = "failed to initialize sqlite state runtime") {
  return new ViteHubError("PROVIDER_LAUNCH_FAILED", "[vitehub] Provider launch command failed.", { details: { exitCode: 1, phase: "launch", stderr } })
}

/** Emit the events, then fail with the error when one is given. */
async function* emits(events: string[], error?: unknown): AsyncGenerator<string> {
  yield* events
  if (error) throw error
}

const failsBeforeFirstEvent = () => emits([], launchFailure())

async function collect(events: AsyncIterable<string>) {
  const values: string[] = []
  for await (const event of events) values.push(event)
  return values
}

describe("Provider launch retry", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("launches again after 2 s and 8 s when the provider exits before its first event", async () => {
    expect(providerLaunchRetryDelaysMs).toEqual([2_000, 8_000])
    const launch = vi.fn<() => AsyncIterable<string>>()
      .mockImplementationOnce(failsBeforeFirstEvent)
      .mockImplementationOnce(failsBeforeFirstEvent)
      .mockImplementationOnce(() => emits(["started", "done"]))

    const result = collect(retryProviderLaunch(launch, undefined, providerLaunchRetryDelaysMs))
    await vi.advanceTimersByTimeAsync(0)
    expect(launch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(launch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(launch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(launch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toEqual(["started", "done"])
    expect(launch).toHaveBeenCalledTimes(3)
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it("reports the last launch failure when every attempt exits early", async () => {
    const launch = vi.fn(failsBeforeFirstEvent)

    const result = collect(retryProviderLaunch(launch, undefined, [10, 20]))
    const rejection = expect(result).rejects.toMatchObject({ code: "PROVIDER_LAUNCH_FAILED" })
    await vi.advanceTimersByTimeAsync(30)

    await rejection
    expect(launch).toHaveBeenCalledTimes(3)
  })

  it("does not launch again after the provider emitted an event", async () => {
    const launch = vi.fn(() => emits(["started"], launchFailure()))

    await expect(collect(retryProviderLaunch(launch, undefined, [10, 20]))).rejects.toMatchObject({ code: "PROVIDER_LAUNCH_FAILED" })
    expect(launch).toHaveBeenCalledOnce()
  })

  it("does not launch again after other failures", async () => {
    const launch = vi.fn(() => emits([], new Error("model request failed")))

    await expect(collect(retryProviderLaunch(launch, undefined, [10, 20]))).rejects.toThrow("model request failed")
    expect(launch).toHaveBeenCalledOnce()
  })

  it("stops waiting and does not launch again when the invocation is aborted", async () => {
    const controller = new AbortController()
    const launch = vi.fn(failsBeforeFirstEvent)

    const result = collect(retryProviderLaunch(launch, controller.signal, [2_000, 8_000]))
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(500)
    controller.abort()

    await rejection
    expect(launch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not launch again when the invocation was already aborted", async () => {
    const controller = new AbortController()
    const launch = vi.fn(() => {
      controller.abort()
      return emits([], launchFailure())
    })

    await expect(collect(retryProviderLaunch(launch, controller.signal, [10, 20]))).rejects.toMatchObject({ code: "PROVIDER_LAUNCH_FAILED" })
    expect(launch).toHaveBeenCalledOnce()
    expect(console.warn).not.toHaveBeenCalled()
  })
})
