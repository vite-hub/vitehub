import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { defineContent, defineContentGitHubWebhookHandler, registerContentKV } from "../src/index.ts"

import type { MockInstance } from "vitest"
import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const url = "https://docs.test/_vitehub/content/github"
const secret = "webhook-secret"
const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub
let warn: MockInstance<typeof console.warn>

const page = (title: string) => `---\ntitle: ${title}\n---\nBody\n`

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-webhook-"))
  enableViteHubTestMode({ root })
  cleanup.push(async () => {
    await enableViteHubTestMode({ root }).reset()
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
    await rm(root, { recursive: true, force: true })
  })
  fake = createFakeGitHub({ owner: "acme", repo: "docs" })
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
  vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", secret)
  vi.stubEnv("FORGES_GITHUB_WEBHOOK_SECRET", "")
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  warn.mockRestore()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** One Content runtime and its webhook route, as one server instance would create them. */
async function server() {
  const content = defineContent({ access: "public", sources: { docs: github({ repo: "acme/docs", ref: "main" }) }, logger: false })
  cleanup.push(() => content.dispose())
  const route = defineContentGitHubWebhookHandler(content)
  // The first read stores the head, as the first page request would.
  await content.sources.head("docs")
  return { content, route }
}

async function title(content: Awaited<ReturnType<typeof server>>["content"], path: string) {
  return (await content.get(path))?.data.title
}

function warned(code: string) {
  return warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes(code))
}

describe("GitHub push webhook", () => {
  it("moves the head to a signed push and records the delivery", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content, route } = await server()
    expect(await title(content, "/guide")).toBe("Guide")

    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    const response = await route.fetch(fake.webhook(url, secret))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sources: ["docs"], deliveries: [{ id: "delivery-1", sha: second, result: "moved" }] })
    expect(await title(content, "/guide")).toBe("Guide v2")
    const head = await content.sources.head("docs")
    expect(head).toMatchObject({ sha: second, webhook: { id: "delivery-1", sha: second, result: "moved" } })
    expect(Date.parse(head.webhook!.at)).not.toBeNaN()
    expect(first).not.toBe(second)
  })

  it("records a push whose commit does not parse as rejected", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content, route } = await server()

    const bad = fake.commit("main", { "broken.md": "---\ntitle: [unclosed\n---\n" })
    const response = await route.fetch(fake.webhook(url, secret))

    expect(await response.json()).toMatchObject({ deliveries: [{ sha: bad, result: "rejected" }] })
    expect(await content.sources.head("docs")).toMatchObject({ sha: first, rejected: { sha: bad }, webhook: { result: "rejected" } })
  })

  it("answers 401 to a bad or missing signature and keeps the head", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content, route } = await server()
    fake.commit("main", { "guide.md": page("Guide v2") })

    const wrong = await route.fetch(fake.webhook(url, "another-secret"))
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({ code: "CONTENT_R0024" })
    const request = fake.webhook(url, secret)
    request.headers.delete("x-hub-signature-256")
    expect((await route.fetch(request)).status).toBe(401)

    expect(warned("CONTENT_R0024")).toHaveLength(2)
    expect(await content.sources.head("docs")).toMatchObject({ sha: first, webhook: null })
    expect(await title(content, "/guide")).toBe("Guide")
  })

  it("ignores pushes to another branch", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content, route } = await server()
    fake.commit("feature", { "guide.md": page("Feature") })

    const response = await route.fetch(fake.webhook(url, secret, { branch: "feature" }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ignored: "No github() Source follows refs/heads/feature." })
    expect(await content.sources.head("docs")).toMatchObject({ sha: first, webhook: null })
  })

  it("ignores pushes to another repository with CONTENT_R0025", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const { route } = await server()

    const response = await route.fetch(fake.webhook(url, secret, { repo: "acme/other" }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ code: "CONTENT_R0025" })
    expect(warned("CONTENT_R0025")).toEqual([expect.stringContaining("acme/other")])
  })

  it("answers GitHub's ping", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const { route } = await server()

    const response = await route.fetch(fake.webhook(url, secret, { event: "ping" }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it("advances after the response when the host has waitUntil", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const { content, route } = await server()
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    const tasks: Promise<unknown>[] = []
    const request = fake.webhook(url, secret)
    Object.defineProperty(request, "waitUntil", { value: (task: Promise<unknown>) => tasks.push(task) })

    const response = await route.fetch(request)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ sources: ["docs"] })
    expect(tasks).toHaveLength(1)
    await Promise.all(tasks)
    expect(await content.sources.head("docs")).toMatchObject({ sha: second, webhook: { result: "moved" } })
  })

  it("is disabled with CONTENT_R0026 when the Server Env has no webhook secret", async () => {
    vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "")
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content, route } = await server()
    fake.commit("main", { "guide.md": page("Guide v2") })

    expect((await route.fetch(fake.webhook(url, secret))).status).toBe(404)
    expect((await route.fetch(fake.webhook(url, secret))).status).toBe(404)

    expect(warned("CONTENT_R0026")).toEqual([expect.stringContaining("VITEHUB_GITHUB_WEBHOOK_SECRET")])
    expect((await content.sources.head("docs")).sha).toBe(first)
  })
})

describe("hourly check without a webhook", () => {
  it("resolves the branch again one hour after the last check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content } = await server()
    const second = fake.commit("main", { "guide.md": page("Guide v2") })

    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(await title(content, "/guide")).toBe("Guide")
    expect((await content.sources.head("docs")).sha).toBe(first)

    vi.advanceTimersByTime(31 * 60 * 1000)
    expect(await title(content, "/guide")).toBe("Guide v2")
    const head = await content.sources.head("docs")
    expect(head.sha).toBe(second)
    expect(Date.parse(head.checkedAt!)).toBe(Date.now())
  })

  it("keeps a pin that another server instance stores while a read checks the branch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const reader = await server()
    const writer = await server()
    fake.commit("main", { "guide.md": page("Guide v2") })
    vi.advanceTimersByTime(61 * 60 * 1000)

    // The reader stops after it reads the old head, and the writer pins the first commit.
    let paused: Promise<void> | undefined
    let resume!: () => void
    let reached!: () => void
    const atHead = new Promise<void>((resolve) => { reached = resolve })
    paused = new Promise<void>((resolve) => { resume = resolve })
    registerContentKV({
      async get<T>(key: string) {
        const result = await kv.get<T>(key)
        const gate = key === "content:head:docs" ? paused : undefined
        if (gate) {
          paused = undefined
          reached()
          await gate
        }
        return result
      },
      set: (key, value) => kv.set(key, value),
    })
    const reading = reader.content.sources.head("docs")
    await atHead
    await writer.content.sources.pin(first, "docs")
    resume()
    expect(await reading).toMatchObject({ sha: first, pinned: true })
    expect(await writer.content.sources.head("docs")).toMatchObject({ sha: first, pinned: true })
  })

  it("writes the head key once per check, within the KV limit of one write per key per second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    const { content } = await server()
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    vi.advanceTimersByTime(61 * 60 * 1000)
    // Cloudflare KV answers 429 to a second write of one key within a second.
    const written = new Map<string, number>()
    registerContentKV({
      get: key => kv.get(key),
      async set(key, value) {
        const last = written.get(key)
        if (last !== undefined && Date.now() - last < 1000) return [new Error("KV PUT failed: 429 Too Many Requests"), undefined] as const
        written.set(key, Date.now())
        return await kv.set(key, value)
      },
    })
    expect(await title(content, "/guide")).toBe("Guide v2")
    expect((await content.sources.head("docs")).sha).toBe(second)
    // An immediate advance of the same commit stays a no-op under the same provider limit.
    expect(await content.sources.advance("docs")).toMatchObject({ sha: second })
  })

  it.each([
    ["pin", false],
    ["webhook", false],
    ["pin", true],
    ["webhook", true],
  ] as const)("keeps a concurrent %s during an unchanged-branch lookup (rejected: %s)", async (operation, rejected) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const reader = await server()
    const writer = await server()
    if (rejected) {
      fake.branch("last-valid", "main")
      fake.commit("main", { "broken.md": "---\ntitle: [unclosed\n---\n" })
      expect(await reader.content.sources.advance("docs")).toMatchObject({ diagnostic: { code: "CONTENT_R0019" } })
      fake.branch("main", "last-valid")
    }
    vi.advanceTimersByTime(61 * 60 * 1000)

    let resume!: () => void
    let reached!: () => void
    const atBranch = new Promise<void>((resolve) => { reached = resolve })
    const paused = new Promise<void>((resolve) => { resume = resolve })
    let waiting = true
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      // Snapshot the old branch response, then let the other server complete its mutation.
      const response = await fake.fetch(input, init)
      if (waiting && String(input).endsWith("/commits/main")) {
        waiting = false
        reached()
        await paused
      }
      return response
    }))
    const reading = reader.content.sources.head("docs")
    await atBranch
    const sha = operation === "pin" ? first : fake.commit("main", { "guide.md": page("Guide v2") })
    if (operation === "pin") await writer.content.sources.pin(first, "docs")
    else expect((await writer.route.fetch(fake.webhook(url, secret))).status).toBe(200)
    const [, stored] = await kv.get("content:head:docs")
    resume()

    expect(await reading).toMatchObject({ sha, pinned: operation === "pin" })
    expect((await kv.get("content:head:docs"))[1]).toEqual(stored)
  })

  it("records an unchanged check without writing the head, and waits an hour across server instances", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    const one = await server()
    const two = await server()
    const [, stored] = await kv.get("content:head:docs")
    vi.advanceTimersByTime(61 * 60 * 1000)
    const set = vi.fn((key: string, value: unknown) => kv.set(key, value))
    registerContentKV({ get: key => kv.get(key), set })

    const head = await one.content.sources.head("docs")
    expect(Date.parse(head.checkedAt!)).toBe(Date.now())
    expect(set.mock.calls.some(([key]) => key === "content:head:docs")).toBe(false)
    expect((await kv.get("content:head:docs"))[1]).toEqual(stored)
    const requests = fake.requests.length
    vi.advanceTimersByTime(2 * 60 * 1000)
    expect((await two.content.sources.head("docs")).checkedAt).toBe(head.checkedAt)
    expect(fake.requests.length).toBe(requests)

    vi.advanceTimersByTime(60 * 60 * 1000)
    await two.content.sources.head("docs")
    expect(fake.requests.length).toBeGreaterThan(requests)
  })

  it("retries a failed head write after the lease, without recording a completed check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content } = await server()
    const checkedAt = (await content.sources.head("docs")).checkedAt
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    vi.advanceTimersByTime(61 * 60 * 1000)
    let failing = true
    registerContentKV({
      get: key => kv.get(key),
      set: (key, value) => key === "content:head:docs" && failing
        ? Promise.resolve([new Error("KV PUT failed"), undefined] as const)
        : kv.set(key, value),
    })
    await expect(content.sources.head("docs")).rejects.toMatchObject({ code: "CONTENT_R0022" })
    failing = false
    expect(await content.sources.head("docs")).toMatchObject({ sha: first, checkedAt })

    vi.advanceTimersByTime(61 * 1000)
    const head = await content.sources.head("docs")
    expect(head.sha).toBe(second)
    expect(Date.parse(head.checkedAt!)).toBe(Date.now())
  })

  it("checks once per hour across server instances", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    const one = await server()
    const two = await server()
    await title(one.content, "/guide")
    await title(two.content, "/guide")
    vi.advanceTimersByTime(61 * 60 * 1000)

    const before = fake.requests.length
    await title(one.content, "/guide")
    const checked = fake.requests.length
    await title(two.content, "/guide")

    expect(checked).toBeGreaterThan(before)
    expect(fake.requests.length).toBe(checked)
  })
})
