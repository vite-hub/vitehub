import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { connectGitHubRepository } from "../src/providers/github/shared.ts"
import { acquireGitHubPublishReservation, githubPublishReservationMs } from "../src/providers/github/publish-reservation.ts"
import { baseSha, createFakeGitHub } from "./fake-github.ts"

let fake: ReturnType<typeof createFakeGitHub>
const branch = "vitehub/reservations/document"
const acquire = (path = "posts/a.md", lock = branch) => acquireGitHubPublishReservation(connectGitHubRepository("onmax/repo", "token"), { branch: lock, head: baseSha, path })

beforeEach(() => {
  fake = createFakeGitHub()
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it("rejects a live owner but recovers an abandoned reservation after its deadline", async () => {
  const abandoned = await acquire()
  await expect(acquire()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
  vi.advanceTimersByTime(githubPublishReservationMs + 1)
  const successor = await acquire()
  await expect(abandoned.assertOwned()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
  await abandoned.release()
  await successor.assertOwned()
  await successor.release()
  expect(fake.head(branch)).toBeUndefined()
})

it("allows only one contender to recover an expired reservation", async () => {
  await acquire()
  vi.advanceTimersByTime(githubPublishReservationMs + 1)
  const contenders = await Promise.allSettled([acquire(), acquire()])
  expect(contenders.filter(result => result.status === "fulfilled")).toHaveLength(1)
  for (const result of contenders) if (result.status === "fulfilled") await result.value.release()
  expect(fake.head(branch)).toBeUndefined()
})

it("recovers when release failed and permits disjoint documents", async () => {
  const held = await acquire()
  const other = await acquire("posts/b.md", "vitehub/reservations/other")
  let unavailable = true
  fake.respond(request => unavailable && request.operation === "UpdateRefs" ? Response.json({ message: "Unavailable" }, { status: 503 }) : undefined)
  await expect(held.release()).rejects.toThrow()
  vi.advanceTimersByTime(githubPublishReservationMs + 1)
  unavailable = false
  const recovered = await acquire()
  await recovered.release()
  await other.release()
  expect(fake.branchNames().filter(name => name.startsWith("vitehub/reservations/"))).toEqual([])
})

it("recovers old abandoned refs that predate reservation metadata", async () => {
  fake.setBranch(branch, baseSha)
  const recovered = await acquire()
  await recovered.assertOwned()
  await recovered.release()
  expect(fake.head(branch)).toBeUndefined()
})

it("refuses to publish if the ownership read completes after expiry", async () => {
  const held = await acquire()
  fake.respond(request => {
    if (request.method === "GET" && request.path.includes(branch)) vi.advanceTimersByTime(githubPublishReservationMs + 1)
    return undefined
  })
  await expect(held.assertOwned()).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
  await held.release()
})
