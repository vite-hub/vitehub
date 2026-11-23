import { afterEach, expect, it, vi } from "vitest"

import { reportQueueDelivery } from "../playground/_shared/queue-test"
import "../packages/queue/test/e2e-live.mjs"

type SmokeRun = { url: string, directMarker: string, deferMarker: string, timeoutMs: number }
type SmokeTask = (run: SmokeRun) => Promise<void>

const { runE2E } = vi.hoisted(() => ({ runE2E: vi.fn<(_: { dispatch: SmokeTask, wait: SmokeTask }) => Promise<void>>().mockResolvedValue(undefined) }))

vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) }))

vi.mock("@vite-hub/internal/test/e2e-live", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runE2E,
}))

const { dispatch, wait } = runE2E.mock.calls[0]![0]
const run = { url: "https://smoke.example.com", directMarker: "direct", deferMarker: "defer", timeoutMs: 2_500 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it("waits for a stale marker-store probe before dispatching both messages", async () => {
  vi.useFakeTimers()
  let reads = 0
  const dispatches: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname === "/api/tests/queue") {
      return Response.json(init?.method === "POST" ? { ok: true } : { ok: true, seen: ++reads > 1 })
    }
    dispatches.push(url.pathname)
    return Response.json({ ok: true, result: { status: "queued" } })
  }))

  const result = dispatch(run).then(() => undefined, (error: Error) => error.message)
  await vi.runAllTimersAsync()
  expect(await result).toBeUndefined()
  expect(dispatches).toEqual(["/api/queues/welcome", "/api/queues/welcome-defer"])
})

it("stops before dispatch when the probe is still missing at the deadline", async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
    return Response.json(init?.method === "POST" ? { ok: true } : { ok: true, seen: false })
  })
  vi.stubGlobal("fetch", fetch)

  const result = dispatch(run).catch(error => String(error))
  await vi.runAllTimersAsync()
  expect(await result).toContain('stage "marker-store"')
  expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual(Array.from({ length: 4 }, () => "/api/tests/queue"))
})

it("reports read failures after receipt and does not infer non-delivery from an absent marker", async () => {
  vi.useFakeTimers()
  let reads = 0
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
    if (url.searchParams.get("marker") === run.directMarker) {
      return ++reads === 1 ? Response.json({ ok: true, received: true, seen: false }) : new Response(null, { status: 503 })
    }
    return Response.json({ ok: true, received: false, seen: false })
  }))

  const result = wait(run).catch((error: Error) => error.message)
  await vi.runAllTimersAsync()
  expect(await result).toContain('"stage":"marker-read"')
  expect(await result).toContain("503")
  expect(await result).toContain('"stage":"not-received"')
  expect(await result).toContain("callback write")
})

it.each(["received", "done"])("reports a rejected %s callback as a marker write failure", async (failedStage) => {
  const posts: { stage: string, error?: string }[] = []
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    posts.push(body)
    return new Response(null, { status: body.stage === failedStage ? 503 : 200 })
  }))

  await expect(reportQueueDelivery({ callbackUrl: run.url, marker: run.directMarker })).rejects.toThrow("503")
  expect(posts.at(-1)).toMatchObject({ stage: "marker-write", error: expect.stringContaining("503") })
})

it("prints a reported callback failure separately from a handler failure", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => Response.json(url.searchParams.get("marker") === run.directMarker
    ? { ok: true, seen: false, writeError: "callback returned 503" }
    : { ok: true, seen: false, error: "handler threw" })))

  const result = wait(run).catch(error => String(error))
  await vi.runAllTimersAsync()
  expect(await result).toContain('"stage":"marker-write","detail":"callback returned 503"')
  expect(await result).toContain('"stage":"handler-failed","detail":"the consumer handler threw: handler threw"')
})
