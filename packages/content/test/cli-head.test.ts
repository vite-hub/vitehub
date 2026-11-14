import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"
import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { runContentCli } from "../src/cli.ts"
import { defineContent, registerContentKV } from "../src/index.ts"
import { contentOperations } from "../src/operations.ts"

import type { OperationAccess } from "@vite-hub/internal/operations"
import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub
/** When true, the fake GitHub API answers 403 with a spent rate limit, as GitHub does. */
let rateLimited = false

const page = (title: string) => `---\ntitle: ${title}\n---\nBody\n`
const broken = "---\ntitle: [unclosed\n---\nBody\n"

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-head-cli-"))
  enableViteHubTestMode({ root })
  cleanup.push(async () => {
    await enableViteHubTestMode({ root }).reset()
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
    await rm(root, { recursive: true, force: true })
  })
  fake = createFakeGitHub({ owner: "acme", repo: "docs" })
  rateLimited = false
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => rateLimited && String(input instanceof Request ? input.url : input).startsWith("https://api.github.com/")
    ? Promise.resolve(Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }))
    : fake.fetch(input, init)))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
  vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

/** The app: Content with one `github()` Source, behind a fake dev server that answers the operation RPC. */
function app(sources: Record<string, ReturnType<typeof github>> = { docs: github({ repo: "acme/docs", ref: "main" }) }, access: OperationAccess = { mode: "local", sections: "all" }) {
  const content = defineContent({ sources, access: "public", logger: false })
  cleanup.push(() => content.dispose())
  const registry = createOperationRegistry([{ operations: contentOperations }])
  Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ default: content }) })
  cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
  const server = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const { input, operation } = operationRpcRequest(init?.body)
    const result = await runOperation(registry, operation, input, { access, development: true, surface: "cli", user: null })
    return operationRpcResponse(init?.body, result)
  })
  const run = async (...args: string[]) => {
    const stdout = stream()
    const stderr = stream()
    const code = await runContentCli(args, { cwd: "/app", env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" }, rootDir: "/app", stderr, stdout }, { fetch: server })
    return { code, stderr: stderr.output(), stdout: stdout.output() }
  }
  return { content, run }
}

describe("vitehub content head", { timeout: 30_000 }, () => {
  it("shows the head, advances to a valid push, and keeps the head on a broken one", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { run } = app()

    const shown = await run("head")
    expect(shown).toMatchObject({ code: 0, stderr: "" })
    expect(shown.stdout).toMatch(new RegExp(`^docs\\n  Head:      ${first} on main, moved \\S+\\n  Checked:   \\S+\\n$`))

    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    const moved = await run("advance")
    expect(moved.code).toBe(0)
    expect(moved.stdout).toContain(`Moved docs from ${first} to ${second}.\n`)

    const bad = fake.commit("main", { "broken.md": broken })
    const held = await run("advance", "docs")
    expect(held.code).toBe(1)
    expect(held.stdout).toContain(`docs stays on ${second}.\n`)
    expect(held.stdout).toContain(`  Rejected:  ${bad} at `)
    expect(held.stdout).toContain(`  CONTENT_R0019: Commit ${bad} of Content source "docs" failed validation, so Content keeps commit ${second}: broken.md:`)
    expect(held.stdout).toContain("  Fix: Fix the document in the repository and push a new commit")

    const json = await run("head", "docs", "--json")
    expect(JSON.parse(json.stdout)).toMatchObject({ heads: [{ source: "docs", live: true, sha: second, rejected: { sha: bad }, diagnostic: { code: "CONTENT_R0019" } }] })
  })

  it("asks for the Source name when a call moves one of many heads", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content, run } = app({ default: github({ repo: "acme/docs", ref: "main" }), blog: github({ repo: "acme/docs", ref: "main" }) })
    await content.sources.head("default")
    for (const args of [["pin", first], ["advance"], ["unpin"]]) {
      const result = await run(...args)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Name the Source")
    }
    expect(await content.sources.head("default")).toMatchObject({ pinned: false })
  })

  it("does not report a rejection from before the head moved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    const { content, run } = app()
    await content.sources.head("docs")
    const bad = fake.commit("main", { "broken.md": broken })
    expect((await run("advance")).code).toBe(1)
    const fixed = fake.commit("main", { "broken.md": page("Fixed") })
    expect(await run("pin", fixed)).toMatchObject({ code: 0 })
    const unpinned = await run("unpin", "--json")
    expect(unpinned.code).toBe(0)
    expect(JSON.parse(unpinned.stdout)).toMatchObject({ sha: fixed, pinned: false, rejected: { sha: bad }, diagnostic: null })
    expect(await run("advance")).toMatchObject({ code: 0 })
  })

  it.each(["advance", "unpin"])("clears a rejection after %s confirms the branch returned to the serving commit", async (command) => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    fake.branch("last-valid", "main")
    const { run } = app()
    await run("head")
    const bad = fake.commit("main", { "broken.md": broken })
    fake.branch("rejected", "main")
    expect(await run("advance")).toMatchObject({ code: 1 })
    expect(await run("advance")).toMatchObject({ code: 1 })

    fake.branch("main", "last-valid")
    const recovered = await run(command, "--json")
    expect(recovered.code).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({ sha: first, pinned: false, rejected: { sha: bad }, diagnostic: null })
    expect(await run("advance")).toMatchObject({ code: 0 })

    // Recovery is stored in KV and survives a new server instance.
    vi.mocked(console.warn).mockClear()
    const restarted = app()
    const shown = await restarted.run("head", "--json")
    expect(JSON.parse(shown.stdout)).toMatchObject({ heads: [{ sha: first, rejected: { sha: bad }, diagnostic: null }] })
    expect(console.warn).not.toHaveBeenCalled()
    // Returning to the invalid commit must make its rejection active again.
    fake.branch("main", "rejected")
    const blocked = await restarted.run("advance", "--json")
    expect(blocked.code).toBe(1)
    expect(JSON.parse(blocked.stdout)).toMatchObject({ sha: first, diagnostic: { code: "CONTENT_R0019" } })
  })

  it("pins a commit for a rollback and unpins it", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { content, run } = app()
    await content.sources.head("docs")
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    await content.sources.advance("docs")

    const pinned = await run("pin", first)
    expect(pinned).toMatchObject({ code: 0, stderr: "" })
    expect(pinned.stdout).toContain(`Pinned docs to ${first}. It stays there until \`vitehub content unpin docs\`.\n`)
    expect((await content.get("/guide"))?.data.title).toBe("Guide")

    fake.commit("main", { "guide.md": page("Guide v3") })
    const kept = await run("advance")
    expect(kept).toMatchObject({ code: 0 })
    expect(kept.stdout).toContain(`docs is pinned to ${first}, so it did not move.`)

    const unpinned = await run("unpin", "--json")
    expect(unpinned.code).toBe(0)
    expect(JSON.parse(unpinned.stdout)).toMatchObject({ source: "docs", pinned: false, sha: expect.not.stringMatching(new RegExp(`^(${first}|${second})$`)) })

    const invalid = await run("pin", "abc")
    expect(invalid).toMatchObject({ code: 1, stdout: "" })
    expect(invalid.stderr).toContain("needs a full 40-character commit SHA")
    expect(await run("pin")).toMatchObject({ code: 1, stderr: expect.stringContaining("Missing sha.") })
  })

  it("shows why a Source has no head, with the fix", async () => {
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
    fake.commit("main", { "guide.md": page("Guide") })
    const { run } = app()

    const shown = await run("head")
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain("docs\n  Not live: each load reads the latest commit without validation.\n  CONTENT_R0020: Content source \"docs\" reads GitHub without a token")
    expect(shown.stdout).toContain("  Fix: Set `VITEHUB_GITHUB_TOKEN` in the Server Env")
    expect(await run("advance")).toMatchObject({ code: 1, stdout: expect.stringContaining("docs has no head, so nothing moved.") })

    const pin = await run("pin", "a".repeat(40), "--json")
    expect(pin.code).toBe(1)
    expect(JSON.parse(pin.stdout)).toMatchObject({ error: { code: "CONTENT_R0020", fix: expect.stringContaining("VITEHUB_GITHUB_TOKEN") } })
  })

  it("shows CONTENT_R0021 without a KV store", async () => {
    registerContentKV(undefined)
    fake.commit("main", { "guide.md": page("Guide") })
    const { run } = app()

    const json = await run("head", "--json")
    expect(JSON.parse(json.stdout)).toMatchObject({ heads: [{ live: false, diagnostic: { code: "CONTENT_R0021", fix: expect.stringContaining("@vite-hub/kv") } }] })
  })

  it("reports CONTENT_R0035 when GitHub rate limits the branch lookup during advance", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { run } = app()
    await run("head")
    fake.commit("main", { "guide.md": page("Guide v2") })

    rateLimited = true
    const limited = await run("advance")
    expect(limited.code).toBe(1)
    expect(limited.stdout).toContain(`docs stays on ${first}.\n`)
    expect(limited.stdout).toContain(`  CONTENT_R0035: GitHub refused the branch lookup of Content source "docs" with 403 or 429, as it does when the rate limit is hit, so Content keeps commit ${first}.`)
    expect(limited.stdout).toContain("  Fix: Wait until the GitHub rate limit resets, then run `vitehub content advance`.")

    rateLimited = false
    const moved = await run("advance", "--json")
    expect(moved.code).toBe(0)
    expect(JSON.parse(moved.stdout)).toMatchObject({ diagnostic: null })
  })

  it("lists every github() Source, and asks for a name to move one of several", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const { run } = app({ docs: github({ repo: "acme/docs", ref: "main" }), blog: github({ repo: "acme/docs", ref: "main" }) })

    const shown = await run("head")
    expect(shown.stdout).toMatch(/^docs\n[\s\S]*\n\nblog\n/)
    const ambiguous = await run("advance")
    expect(ambiguous.code).toBe(1)
    expect(ambiguous.stderr).toContain("This app has 2 github() Sources: docs, blog. Name the Source")
    expect(await run("advance", "blog")).toMatchObject({ code: 0 })
  })

  it("needs the whole content section to move a head", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const { run } = app(undefined, { mode: "local", sections: ["content:read"] })

    expect(await run("head")).toMatchObject({ code: 0 })
    const denied = await run("advance")
    expect(denied.code).toBe(1)
    expect(denied.stderr).not.toBe("")
  })
})
