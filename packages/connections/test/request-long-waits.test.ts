import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { createRequestScheduler } from "../src/requests.ts"

const delayMs = 2 ** 31

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

it.each(["response", "network"])("preserves long retry backoff after a %s failure", async (failure) => {
  const scheduler = createRequestScheduler()
  const policy = scheduler.resolve("items", { retry: { attempts: 2, delayMs } })
  const starts: number[] = []
  const sent = scheduler.send(policy, {}, async () => {
    starts.push(Date.now())
    if (starts.length === 1 && failure === "network") throw new TypeError("fetch failed")
    return new Response("ok", { status: starts.length === 1 ? 503 : 200 })
  })
  await vi.advanceTimersByTimeAsync(1)
  expect(starts).toEqual([0])
  await vi.advanceTimersByTimeAsync(delayMs - 2)
  expect(starts).toEqual([0])
  await vi.advanceTimersByTimeAsync(1)
  expect((await sent).status).toBe(200)
  expect(starts).toEqual([0, delayMs])
})

it("preserves a rate interval longer than one timer", async () => {
  const scheduler = createRequestScheduler()
  const policy = scheduler.resolve("items", { rate: { intervalMs: delayMs } })
  const starts: number[] = []
  const dispatch = async () => {
    starts.push(Date.now())
    return new Response("ok")
  }
  await scheduler.send(policy, {}, dispatch)
  const sent = scheduler.send(policy, {}, dispatch)
  await vi.advanceTimersByTimeAsync(1)
  expect(starts).toEqual([0])
  await vi.advanceTimersByTimeAsync(delayMs - 1)
  await sent
  expect(starts).toEqual([0, delayMs])
})

it.each([
  { wait: "retry", clockJumpMs: 60_000 },
  { wait: "retry", clockJumpMs: -60_000 },
  { wait: "rate", clockJumpMs: 60_000 },
  { wait: "rate", clockJumpMs: -60_000 },
])("preserves a long $wait wait when the wall clock jumps by $clockJumpMs ms", async ({ wait, clockJumpMs }) => {
  const scheduler = createRequestScheduler()
  const waitMs = delayMs * 2
  const policy = scheduler.resolve("items", wait === "retry"
    ? { retry: { attempts: 2, delayMs: waitMs } }
    : { rate: { intervalMs: waitMs } })
  const starts: number[] = []
  const dispatch = async () => {
    starts.push(performance.now())
    return new Response("ok", { status: wait === "retry" && starts.length === 1 ? 503 : 200 })
  }
  if (wait === "rate") await scheduler.send(policy, {}, dispatch)
  const sent = scheduler.send(policy, {}, dispatch)
  await vi.advanceTimersByTimeAsync(delayMs - 1)
  expect(starts).toEqual([0])
  vi.setSystemTime(Date.now() + clockJumpMs)
  await vi.advanceTimersByTimeAsync(delayMs - 1)
  expect(starts).toEqual([0])
  await vi.advanceTimersByTimeAsync(1)
  expect(starts).toEqual([0])
  await vi.advanceTimersByTimeAsync(1)
  expect(starts).toEqual([0, waitMs])
  expect((await sent).status).toBe(200)
})

it("cancels a long retry wait without sending another request", async () => {
  const scheduler = createRequestScheduler()
  const policy = scheduler.resolve("items", { retry: { attempts: 2, delayMs } })
  const caller = new AbortController()
  const dispatch = vi.fn(async () => new Response("retry", { status: 503 }))
  const sent = scheduler.send(policy, { signal: caller.signal }, dispatch)
  const outcome = sent.then(() => "completed", error => error)
  await vi.advanceTimersByTimeAsync(delayMs - 1)
  caller.abort("stopped")
  expect(await outcome).toBe("stopped")
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
