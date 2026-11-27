import { afterEach, expect, it, vi } from "vitest"

import "../packages/workflow/test/e2e-live.mjs"

type SmokeRun = { url: string, directMarker: string, deferMarker: string, timeoutMs: number }
type Dispatched = { directId: string }

const { runE2E } = vi.hoisted(() => ({
  runE2E: vi.fn<(_: { dispatch: (run: SmokeRun) => Promise<Dispatched>, wait: (run: SmokeRun, dispatched: Dispatched) => Promise<void> }) => Promise<void>>().mockResolvedValue(undefined),
}))

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

it("starts both runs at once without custom run ids", async () => {
  const pending: Array<{ path: string, body: Record<string, unknown>, resolve: (response: Response) => void }> = []
  vi.stubGlobal("fetch", vi.fn((url: URL, init: RequestInit) => new Promise<Response>((resolve) => {
    pending.push({ body: JSON.parse(String(init.body)), path: url.pathname, resolve })
  })))

  const result = dispatch(run)
  await vi.waitFor(() => expect(pending).toHaveLength(2))
  expect(pending.map(request => request.path)).toEqual(["/api/workflows/welcome", "/api/workflows/welcome-defer"])
  for (const request of pending) {
    expect(request.body).not.toHaveProperty("id")
    expect(request.body.callbackUrl).toBe("https://smoke.example.com/api/tests/queue")
  }
  pending[0]!.resolve(Response.json({ ok: true, result: { id: "wrun_1" } }))
  pending[1]!.resolve(Response.json({ ok: true }))
  expect(await result).toEqual({ directId: "wrun_1" })
})

it("reads the direct run by its returned id and the deferred run by its marker", async () => {
  vi.useFakeTimers()
  let markerReads = 0
  const reads: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
    reads.push(`${url.pathname}${url.search}`)
    if (url.pathname === "/api/workflows/welcome/wrun_1") return Response.json({ id: "wrun_1", result: { marker: "direct" }, status: "completed" })
    return Response.json({ ok: true, seen: ++markerReads > 1 })
  }))

  const result = wait(run, { directId: "wrun_1" }).then(() => undefined, (error: Error) => error.message)
  await vi.runAllTimersAsync()
  expect(await result).toBeUndefined()
  expect(reads).toContain("/api/workflows/welcome/wrun_1")
  expect(reads).toContain("/api/tests/queue?marker=defer")
})

it("fails when the direct run completes with another marker or the deferred marker never shows", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => url.pathname.startsWith("/api/workflows/")
    ? Response.json({ id: "wrun_1", result: { marker: "other" }, status: "completed" })
    : Response.json({ ok: true, seen: false })))

  const result = wait(run, { directId: "wrun_1" }).catch((error: Error) => error.message)
  await vi.runAllTimersAsync()
  expect(await result).toContain("completed with an unexpected result")
  expect(await result).toContain('"marker":"defer"')
})
