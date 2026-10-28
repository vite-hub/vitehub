import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { connectGitHubRepository } from "../src/providers/github/shared.ts"
import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"
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

it("does not reclaim a reservation while GitHub is still creating the pull request", async () => {
  const head = "vitehub/publish/first"
  const other = "vitehub/publish/second"
  fake.setBranch(head, baseSha)
  fake.commit(head, { "posts/a.md": "first" })
  fake.setBranch(other, baseSha)
  fake.commit(other, { "posts/a.md": "second" })
  const history = () => createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", token: "token", root: "" }, "content").history!
  const reservation = { headPrefix: "vitehub/publish/", paths: ["posts/a.md"] }
  let dispatch!: () => void
  let complete!: () => void
  const started = new Promise<void>(resolve => { dispatch = resolve })
  const finish = new Promise<void>(resolve => { complete = resolve })
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    if (init?.method === "POST" && String(input).endsWith("/pulls") && body?.head === head) {
      dispatch()
      await finish
    }
    return fake.fetch(input, init)
  }))
  const opening = history().openPullRequest!({ head, base: "main", title: "First", reservation })
  await started
  vi.advanceTimersByTime(githubPublishReservationMs + 1)
  let successor: unknown
  try {
    successor = await history().openPullRequest!({ head: other, base: "main", title: "Second", reservation }).catch((error: unknown) => error)
  }
  finally {
    complete()
    await opening
  }
  expect(successor).toMatchObject({ code: "WORKSPACE_CONFLICT" })
  expect(fake.pulls).toHaveLength(1)
})

it.each(["timeout", "server error", "malformed response"])("retains an ambiguous %s until GitHub exposes the original PR", async (failure) => {
  const head = "vitehub/publish/first"
  const other = "vitehub/publish/second"
  fake.setBranch(head, baseSha)
  fake.commit(head, { "posts/a.md": "first", "posts/b.md": "first" })
  fake.setBranch(other, baseSha)
  fake.commit(other, { "posts/a.md": "second", "posts/b.md": "second" })
  const history = () => createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", token: "token", root: "" }, "content").history!
  const reservation = { headPrefix: "vitehub/publish/", paths: ["posts/a.md", "posts/b.md"] }
  fake.respond(request => {
    if (request.method !== "POST" || !request.path.endsWith("/pulls") || request.body?.head !== head) return undefined
    if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError")
    return Response.json({ message: "Unknown outcome" }, { status: failure === "server error" ? 503 : 201 })
  })
  await expect(history().openPullRequest!({ head, base: "main", title: "First", reservation, deleteHeadOnFailure: true })).rejects.toThrow()
  expect(fake.head(head)).toBeDefined()
  vi.advanceTimersByTime(githubPublishReservationMs + 1)
  for (const path of reservation.paths) {
    await expect(history().openPullRequest!({ head: other, base: "main", title: "Second", reservation: { ...reservation, paths: [path] } })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
  }
  expect(fake.requests.filter(request => request.method === "POST" && request.path.endsWith("/pulls"))).toHaveLength(1)
  // The server finishes the first mutation after its client has already stopped waiting.
  fake.openPull(head, "main", "First")
  await expect(history().openPullRequest!({ head: other, base: "main", title: "Second", reservation })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
  expect(fake.pulls).toHaveLength(1)
  fake.pulls[0]!.state = "closed"
  await expect(history().openPullRequest!({ head: other, base: "main", title: "Second", reservation })).resolves.toMatchObject({ number: 2 })
  expect(fake.branchNames().filter(name => name.startsWith("vitehub/reservations/"))).toEqual([])
})

it("releases reservations and deletes the branch after a definitive PR rejection", async () => {
  const head = "vitehub/publish/rejected"
  fake.setBranch(head, baseSha)
  fake.commit(head, { "posts/a.md": "first" })
  const target = createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", token: "token", root: "" }, "content").history!
  fake.respond(request => request.method === "POST" && request.path.endsWith("/pulls")
    ? Response.json({ message: "Validation Failed" }, { status: 422 }) : undefined)
  await expect(target.openPullRequest!({ head, base: "main", title: "Rejected", reservation: { headPrefix: "vitehub/publish/", paths: ["posts/a.md"] }, deleteHeadOnFailure: true })).rejects.toThrow("422")
  expect(fake.head(head)).toBeUndefined()
  expect(fake.branchNames().filter(name => name.startsWith("vitehub/reservations/"))).toEqual([])
})
