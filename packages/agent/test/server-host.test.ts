import { generateKeyPairSync } from "node:crypto"
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createMemoryAgentInvocationStore,
  failInterruptedAgentInvocations,
  summarizeAgentInvocationWorkload,
} from "../src/server.ts"
import { createGitHubHost, parseGraphQLRateLimit } from "../src/server/github.ts"

const originalPath = process.env.PATH
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.env.PATH = originalPath
  delete process.env.VITEHUB_TEST_HEAD_SHA
  delete process.env.VITEHUB_TEST_CLONE_DELAY
  delete process.env.VITEHUB_TEST_COMMAND_LOG
  delete process.env.VITEHUB_TEST_RATE_LIMIT
  delete process.env.VITEHUB_TEST_RATE_LIMIT_DELAY
  delete process.env.VITEHUB_TEST_RATE_LIMIT_REMAINING
  delete process.env.VITEHUB_TEST_RATE_LIMIT_RESET
  await Promise.all([...temporaryDirectories].map(path => rm(path, { force: true, recursive: true })))
  temporaryDirectories.clear()
})

async function installFakeGitHubCommands(): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 123 }), { status: 200 })))
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-host-test-"))
  temporaryDirectories.add(root)
  await Promise.all([
    writeFile(join(root, "gh"), `#!/bin/sh
if [ -n "$VITEHUB_TEST_COMMAND_LOG" ]; then
  printf 'gh %s|%s|%s\\n' "$*" "$GIT_CONFIG_VALUE_1" "$GH_TOKEN" >> "$VITEHUB_TEST_COMMAND_LOG"
fi
if [ -n "$VITEHUB_TEST_RATE_LIMIT" ]; then
  printf '%s\\n' "$VITEHUB_TEST_RATE_LIMIT" >&2
  exit 1
fi
if [ "$1" = "repo" ] && [ "$2" = "clone" ] && [ -n "$VITEHUB_TEST_CLONE_DELAY" ]; then
  sleep "$VITEHUB_TEST_CLONE_DELAY"
fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "github.com" ] && [ "$4" = "rate_limit" ]; then
  if [ -n "$VITEHUB_TEST_RATE_LIMIT_DELAY" ]; then sleep "$VITEHUB_TEST_RATE_LIMIT_DELAY"; fi
  printf '%s\\n' "{\\"resources\\":{\\"graphql\\":{\\"remaining\\":\${VITEHUB_TEST_RATE_LIMIT_REMAINING:-100},\\"reset\\":\${VITEHUB_TEST_RATE_LIMIT_RESET:-2000000000}}}}"
fi
`, { mode: 0o755 }),
    writeFile(join(root, "git"), `#!/bin/sh
if [ -n "$VITEHUB_TEST_COMMAND_LOG" ]; then
  printf 'git %s|%s\n' "$*" "$GH_TOKEN" >> "$VITEHUB_TEST_COMMAND_LOG"
fi
case "$*" in
  *"rev-parse HEAD"*) printf '%s\\n' "$VITEHUB_TEST_HEAD_SHA" ;;
esac
`, { mode: 0o755 }),
  ])
  await Promise.all([chmod(join(root, "gh"), 0o755), chmod(join(root, "git"), 0o755)])
  process.env.PATH = `${root}:${originalPath}`
}

describe("GitHub host", () => {
  it("does not resolve credentials for a pre-aborted operation", async () => {
    const credentials = vi.fn(() => Promise.reject(new Error("resolver should not run")))
    const host = createGitHubHost({ credentials })
    const controller = new AbortController()
    controller.abort(new Error("already cancelled"))

    await expect(host.access({ signal: controller.signal })).rejects.toThrow("already cancelled")
    expect(credentials).not.toHaveBeenCalled()
  })

  it("parses GitHub GraphQL rate limits", () => {
    expect(parseGraphQLRateLimit({ resources: { graphql: { remaining: 1_234, reset: 1_800 } } }, 900)).toEqual({
      checkedAt: 900,
      remaining: 1_234,
      resetAt: 1_800_000,
    })
    expect(() => parseGraphQLRateLimit({ resources: { graphql: { remaining: -1, reset: 1_800 } } })).toThrow(
      "GitHub did not return a valid GraphQL rate limit.",
    )
  })

  it("caches installation tokens and projects Git identity", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      token: "installation-token",
    }), { status: 201 }))
    vi.stubGlobal("fetch", fetcher)
    const host = createGitHubHost({
      credentials: () => ({
        appId: 123,
        installationId: 456,
        owner: "vite-hub",
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
      identity: { email: "bot@vitehub.dev", login: "vitehub-bot" },
    })

    const first = await host.access({ repository: "vite-hub/vitehub" })
    const second = await host.access({ repository: "vite-hub/babysitter" })

    expect(first).toMatchObject({
      env: {
        GH_TOKEN: "installation-token",
        GIT_AUTHOR_EMAIL: "bot@vitehub.dev",
        GIT_AUTHOR_NAME: "vitehub-bot",
      },
      token: "installation-token",
    })
    expect(second.token).toBe("installation-token")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/456/access_tokens",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("uses the fallback token outside the App owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 123 }), { status: 200 })))
    const host = createGitHubHost({
      credentials: () => ({
        appId: 123,
        installationId: 456,
        owner: "vite-hub",
        privateKey: "unused-for-fallback",
        token: { unseal: () => "fallback-token" },
      }),
    })

    await expect(host.access({ repository: "contributor/fork" })).resolves.toMatchObject({ token: "fallback-token" })
  })

  it.each(["abort", "timeout"] as const)("cancels credential resolution on %s", async (control) => {
    const controller = new AbortController()
    let credentialSignal: AbortSignal | undefined
    const host = createGitHubHost({
      credentials: ({ signal }) => {
        credentialSignal = signal
        return new Promise(() => undefined)
      },
    })
    if (control === "abort") setTimeout(() => controller.abort(new Error("credential cancelled")), 20)

    await expect(host.access(control === "abort" ? { signal: controller.signal } : { timeout: 20 })).rejects.toThrow(
      control === "abort" ? "credential cancelled" : "timed out",
    )
    expect(credentialSignal?.aborted).toBe(true)
  })

  it("cancels installation-token refresh", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })))
    const host = createGitHubHost({
      credentials: () => ({
        appId: 123,
        installationId: 456,
        owner: "vite-hub",
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("cancelled")), 20)

    await expect(host.access({ repository: "vite-hub/vitehub", signal: controller.signal })).rejects.toThrow("cancelled")
  })

  it.each(["abort", "timeout"] as const)("keeps installation-token %s active through body parsing", async (control) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
      },
    }), { status: 201 })))
    const host = createGitHubHost({
      credentials: () => ({
        appId: 123,
        installationId: 456,
        owner: "vite-hub",
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    })
    const controller = new AbortController()
    if (control === "abort") setTimeout(() => controller.abort(new Error("cancelled during body")), 20)

    await expect(host.access({
      repository: "vite-hub/vitehub",
      ...(control === "abort" ? { signal: controller.signal } : { timeout: 20 }),
    })).rejects.toThrow(control === "abort" ? "cancelled during body" : /abort|timed out|timeout/i)
  })

  it("admits GraphQL work against a shared reserve", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 1_500 })

    let failure: unknown
    try {
      await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 })
    }
    catch (error) {
      failure = error
    }

    expect(host.isRateLimitError(failure)).toBe(true)
    expect(host.budget()).toEqual({ limited: true, remaining: 100, resetAt: 2_000_000_000_000 })
  })

  it("shares fallback-token GraphQL budgets across repository owners", async () => {
    await installFakeGitHubCommands()
    const commandLog = join(tmpdir(), `vitehub-agent-host-commands-${crypto.randomUUID()}`)
    temporaryDirectories.add(commandLog)
    process.env.VITEHUB_TEST_COMMAND_LOG = commandLog
    const host = createGitHubHost({ credentials: () => ({ token: "shared-token" }), reserve: 0 })

    await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 })
    await host.ensureGraphQLBudget("contributor/fork", { cost: 1 })

    const commands = await readFile(commandLog, "utf8")
    expect(commands.match(/gh api --hostname github\.com rate_limit/g)).toHaveLength(1)
  })

  it("shares fallback GraphQL budgets across token rotation for one user", async () => {
    await installFakeGitHubCommands()
    let token = "first-token"
    const host = createGitHubHost({ credentials: () => ({ token }), reserve: 10 })

    await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    token = "rotated-token"
    await expect(host.ensureGraphQLBudget("contributor/fork", { cost: 31 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
  })

  it("shares fallback installation-token budgets across rotation", async () => {
    await installFakeGitHubCommands()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(undefined, { status: 403 })))
    let token = "first-installation-token"
    const host = createGitHubHost({ credentials: () => ({ rateLimitKey: "installation:123", token }), reserve: 10 })

    await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    token = "second-installation-token"
    await expect(host.ensureGraphQLBudget("contributor/fork", { cost: 31 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
  })

  it("keeps distinct fallback installation-token budgets isolated", async () => {
    await installFakeGitHubCommands()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(undefined, { status: 403 })))
    let credentials = { rateLimitKey: "installation:123", token: "first-installation-token" }
    const host = createGitHubHost({ credentials: () => credentials, reserve: 10 })

    await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    credentials = { rateLimitKey: "installation:456", token: "second-installation-token" }
    await expect(host.ensureGraphQLBudget("contributor/fork", { cost: 60 }))
      .resolves.toMatchObject({ remaining: 40 })
  })

  it("reserves cached GraphQL budget before admitting more work", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 10 })

    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 }))
      .resolves.toMatchObject({ remaining: 40 })
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 31 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
  })

  it("preserves outstanding GraphQL reservations across budget refreshes", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ cacheMs: 0, credentials: () => ({ token: "token" }), reserve: 10 })

    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 }))
      .resolves.toMatchObject({ remaining: 40 })
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 31 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
  })

  it("preserves unsent reservations across external credential use", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ cacheMs: 0, credentials: () => ({ token: "token" }), reserve: 10 })

    await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    process.env.VITEHUB_TEST_RATE_LIMIT_REMAINING = "40"
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 20 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
  })

  it("releases abandoned GraphQL reservations", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 10 })

    const reservation = await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    reservation.release()
    reservation.release()
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 }))
      .resolves.toMatchObject({ remaining: 40 })
  })

  it("settles overestimated GraphQL reservations with their actual cost", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 10 })

    const reservation = await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    reservation.settle(40)
    reservation.settle(30)
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 11 }))
      .resolves.toMatchObject({ remaining: 49 })
  })

  it("does not double-count a query settled after a budget refresh", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ cacheMs: 5, credentials: () => ({ token: "token" }), reserve: 10 })

    const reservation = await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    process.env.VITEHUB_TEST_RATE_LIMIT_REMAINING = "60"
    await new Promise(resolve => setTimeout(resolve, 10))
    await host.ensureGraphQLBudget("vite-hub/another", { cost: 1 })
    reservation.settle(40)
    await expect(host.ensureGraphQLBudget("vite-hub/third", { cost: 9 }))
      .resolves.toMatchObject({ remaining: 50 })
  })

  it("rejects an actual GraphQL cost above its reservation", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 10 })

    const first = await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    await host.ensureGraphQLBudget("vite-hub/another", { cost: 30 })
    expect(() => first.settle(70)).toThrow("GitHub GraphQL actual cost cannot exceed its reserved cost.")
    await expect(host.ensureGraphQLBudget("vite-hub/third", { cost: 1 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
  })

  it("rejects an invalid actual GraphQL cost", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 10 })

    const reservation = await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    expect(() => reservation.settle(-1)).toThrow("GitHub GraphQL actual cost must be a non-negative integer.")
  })

  it("pins GraphQL budget checks to github.com", async () => {
    await installFakeGitHubCommands()
    const commandLog = join(tmpdir(), `vitehub-agent-host-commands-${crypto.randomUUID()}`)
    temporaryDirectories.add(commandLog)
    process.env.VITEHUB_TEST_COMMAND_LOG = commandLog
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 10 })

    await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 })

    expect(await readFile(commandLog, "utf8")).toContain("gh api --hostname github.com rate_limit")
  })

  it("refreshes a cached GraphQL budget after its reset", async () => {
    await installFakeGitHubCommands()
    const commandLog = join(tmpdir(), `vitehub-agent-host-commands-${crypto.randomUUID()}`)
    temporaryDirectories.add(commandLog)
    process.env.VITEHUB_TEST_COMMAND_LOG = commandLog
    process.env.VITEHUB_TEST_RATE_LIMIT_RESET = String(Math.floor(Date.now() / 1_000))
    const host = createGitHubHost({ cacheMs: 60_000, credentials: () => ({ token: "token" }), reserve: 10 })

    await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 })
    process.env.VITEHUB_TEST_RATE_LIMIT_RESET = String(Math.floor(Date.now() / 1_000) + 60)
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 }))
      .resolves.toMatchObject({ remaining: 40 })
    expect((await readFile(commandLog, "utf8")).match(/gh api --hostname github\.com rate_limit/g)).toHaveLength(2)
  })

  it("reports an exact-reserve GraphQL budget as limited", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 10 })

    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 90 }))
      .resolves.toMatchObject({ remaining: 10 })
    expect(host.budget()).toEqual({ limited: true, remaining: 10, resetAt: 2_000_000_000_000 })
  })

  it("reserves shared GraphQL budget atomically", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_RATE_LIMIT_DELAY = "0.1"
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 10 })

    const admissions = await Promise.allSettled([
      host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 60 }),
      host.ensureGraphQLBudget("vite-hub/another", { cost: 31 }),
    ])

    expect(admissions.filter(result => result.status === "fulfilled")).toHaveLength(1)
    const rejection = admissions.find(result => result.status === "rejected")
    expect(rejection?.status === "rejected" && host.isRateLimitError(rejection.reason)).toBe(true)
  })

  it("keeps installation rate-limit state across token refresh", async () => {
    await installFakeGitHubCommands()
    const commandLog = join(tmpdir(), `vitehub-agent-host-commands-${crypto.randomUUID()}`)
    temporaryDirectories.add(commandLog)
    process.env.VITEHUB_TEST_COMMAND_LOG = commandLog
    process.env.VITEHUB_TEST_RATE_LIMIT = "You have exceeded a secondary rate limit."
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      token: `installation-token-${fetcher.mock.calls.length}`,
    }), { status: 201 }))
    vi.stubGlobal("fetch", fetcher)
    const host = createGitHubHost({
      credentials: () => ({
        appId: 123,
        installationId: 456,
        owner: "vite-hub",
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    })

    await expect(host.command(["api", "graphql"], { repository: "vite-hub/vitehub" }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
    await host.access({ refresh: true, repository: "vite-hub/vitehub" })
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await readFile(commandLog, "utf8")).match(/gh api --hostname github\.com rate_limit/g)).toBeNull()
  })

  it("preserves a secondary limit recorded during an installation budget check", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_RATE_LIMIT_DELAY = "0.1"
    const commandLog = join(tmpdir(), `vitehub-agent-host-commands-${crypto.randomUUID()}`)
    temporaryDirectories.add(commandLog)
    process.env.VITEHUB_TEST_COMMAND_LOG = commandLog
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      token: `installation-token-${fetcher.mock.calls.length}`,
    }), { status: 201 }))
    vi.stubGlobal("fetch", fetcher)
    const host = createGitHubHost({
      credentials: () => ({
        appId: 123,
        installationId: 456,
        owner: "vite-hub",
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    })

    const admission = host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 })
    await vi.waitFor(async () => {
      expect(await readFile(commandLog, "utf8")).toContain("gh api --hostname github.com rate_limit")
    })
    await host.access({ refresh: true, repository: "vite-hub/vitehub" })
    process.env.VITEHUB_TEST_RATE_LIMIT = "You have exceeded a secondary rate limit."
    await expect(host.command(["api", "graphql"], { repository: "vite-hub/vitehub" }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
    await expect(admission).rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
    process.env.VITEHUB_TEST_RATE_LIMIT = ""
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await readFile(commandLog, "utf8")).match(/gh api --hostname github\.com rate_limit/g)).toHaveLength(1)
  })

  it("keeps shared GraphQL budget waiters independently cancellable", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_RATE_LIMIT_DELAY = "0.1"
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 0 })
    const firstController = new AbortController()
    const first = host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1, signal: firstController.signal })
    const second = host.ensureGraphQLBudget("vite-hub/another", { cost: 1, timeout: 20 })
    firstController.abort(new Error("first cancelled"))

    await expect(first).rejects.toThrow("first cancelled")
    await expect(second).rejects.toThrow(/timed out/i)
    await expect(host.ensureGraphQLBudget("vite-hub/third", { cost: 1 })).resolves.toMatchObject({ remaining: 99 })
  })

  it("bounds and replaces a stalled shared GraphQL budget check", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_RATE_LIMIT_DELAY = "10"
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), graphQLCheckTimeout: 20, reserve: 0 })

    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 })).rejects.toSatisfy((error: unknown) => {
      return error instanceof Error && (
        ("killed" in error && error.killed === true)
        || ("code" in error && error.code === "ETIMEDOUT")
        || ("code" in error && error.code === "ABORT_ERR")
        || error.name === "AbortError"
        || error.name === "TimeoutError"
      )
    })
    process.env.VITEHUB_TEST_RATE_LIMIT_DELAY = ""
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 })).resolves.toMatchObject({ remaining: 99 })
  })

  it("classifies documented secondary rate limits", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_RATE_LIMIT = "You have exceeded a secondary rate limit."
    const host = createGitHubHost({ credentials: () => ({ token: "token" }) })

    let failure: unknown
    try {
      await host.command(["api", "graphql"], { repository: "vite-hub/vitehub" })
    }
    catch (error) {
      failure = error
    }
    expect(host.isRateLimitError(failure)).toBe(true)
  })

  it("records secondary rate limits without a repository label", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_RATE_LIMIT = "You have exceeded a secondary rate limit."
    const host = createGitHubHost({ credentials: () => ({ token: "token" }) })

    await expect(host.command(["api", "user"])).rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
    process.env.VITEHUB_TEST_RATE_LIMIT = ""
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
  })

  it("classifies GraphQL commands after value-taking flags", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_RATE_LIMIT = "API rate limit exceeded."
    const host = createGitHubHost({ credentials: () => ({ token: "token" }) })

    await expect(host.command(["api", "--preview", "scarlet-witch", "graphql"], { repository: "vite-hub/vitehub" }))
      .rejects.toSatisfy((error: unknown) => host.isRateLimitError(error))
  })

  it("keeps REST primary failures out of the GraphQL budget", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_RATE_LIMIT = "API rate limit exceeded."
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 0 })

    let failure: unknown
    try {
      await host.command(["api", "repos/vite-hub/vitehub"], { repository: "vite-hub/vitehub" })
    }
    catch (error) {
      failure = error
    }
    expect(host.isRateLimitError(failure)).toBe(false)
    process.env.VITEHUB_TEST_RATE_LIMIT = ""
    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 }))
      .resolves.toMatchObject({ remaining: 99 })
  })

  it("honors cancellation before using a cached GraphQL budget", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 0 })
    await host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1 })
    const controller = new AbortController()
    controller.abort(new Error("cancelled before cached admission"))

    await expect(host.ensureGraphQLBudget("vite-hub/vitehub", { cost: 1, signal: controller.signal }))
      .rejects.toThrow("cancelled before cached admission")
  })

  it("cancels generic GitHub commands", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_CLONE_DELAY = "10"
    const host = createGitHubHost({ credentials: () => ({ token: "token" }) })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    await expect(host.command(["repo", "clone"], { signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" })
  })

  it("verifies the exact pull-request head and removes the temporary checkout", async () => {
    await installFakeGitHubCommands()
    const commandLog = join(tmpdir(), `vitehub-agent-host-commands-${crypto.randomUUID()}`)
    temporaryDirectories.add(commandLog)
    process.env.VITEHUB_TEST_COMMAND_LOG = commandLog
    process.env.VITEHUB_TEST_HEAD_SHA = "expected-head"
    const host = createGitHubHost({ credentials: () => ({ token: "token" }) })
    let checkout = ""

    await expect(host.withPullRequestCheckout({
      headRef: "feature",
      headRepository: "contributor/vitehub",
      headSha: "expected-head",
      number: 123,
      repository: "vite-hub/vitehub",
    }, async (access) => {
      checkout = access.path
      expect(access.token).toBe("token")
      return "complete"
    })).resolves.toBe("complete")

    await expect(access(checkout)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(commandLog, "utf8")).resolves.toContain(
      "gh repo clone https://github.com/vite-hub/vitehub.git",
    )
    await expect(readFile(commandLog, "utf8")).resolves.toContain("gh pr checkout 123 --repo vite-hub/vitehub|")
    await expect(readFile(commandLog, "utf8")).resolves.not.toContain("--detach")
    await expect(readFile(commandLog, "utf8")).resolves.toContain("!gh auth git-credential|token")
    await expect(readFile(commandLog, "utf8")).resolves.toContain(
      "git -C " + checkout + " config remote.origin.push HEAD:refs/heads/feature",
    )

    await expect(host.withPullRequestCheckout({
      headSha: "expected-head",
      number: 124,
      repository: "vite-hub/vitehub",
    }, async (checkoutAccess) => {
      checkout = checkoutAccess.path
      throw new Error("callback failed")
    })).rejects.toThrow("callback failed")
    await expect(access(checkout)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refreshes credentials for a host-owned pull-request push", async () => {
    await installFakeGitHubCommands()
    const commandLog = join(tmpdir(), `vitehub-agent-host-commands-${crypto.randomUUID()}`)
    temporaryDirectories.add(commandLog)
    process.env.VITEHUB_TEST_COMMAND_LOG = commandLog
    process.env.VITEHUB_TEST_HEAD_SHA = "expected-head"
    const credentials = vi.fn(() => ({ token: `token-${credentials.mock.calls.length}` }))
    const host = createGitHubHost({ credentials })

    await host.withPullRequestCheckout({
      headRef: "feature",
      headRepository: "contributor/vitehub",
      headSha: "expected-head",
      number: 127,
      repository: "vite-hub/vitehub",
    }, async ({ push }) => await push())

    expect(credentials).toHaveBeenCalledTimes(2)
    await expect(readFile(commandLog, "utf8")).resolves.toContain("push origin|token-2")
  })

  it("keeps one access deadline across credential stages", async () => {
    vi.useFakeTimers()
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })))
    let resolveCredentials: (() => void) | undefined
    const credentialsReady = new Promise<void>((resolve) => {
      resolveCredentials = resolve
    })
    const host = createGitHubHost({
      credentials: async () => {
        await credentialsReady
        return {
          appId: 123,
          installationId: 456,
          owner: "vite-hub",
          privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        }
      },
    })

    const access = host.access({ repository: "vite-hub/vitehub", timeout: 20 })
    const rejection = expect(access).rejects.toThrow(/abort|timed out|timeout/i)
    await vi.advanceTimersByTimeAsync(15)
    resolveCredentials?.()
    await vi.advanceTimersByTimeAsync(5)

    await rejection
  })

  it("cancels checkout commands and removes the temporary checkout", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_CLONE_DELAY = "10"
    const host = createGitHubHost({ credentials: () => ({ token: "token" }) })
    const controller = new AbortController()
    const prefix = "vitehub-vite-hub-vitehub-pr-125-"
    const before = new Set((await readdir(tmpdir())).filter(path => path.startsWith(prefix)))
    setTimeout(() => controller.abort(), 20)

    await expect(host.withPullRequestCheckout({
      headSha: "expected-head",
      number: 125,
      repository: "vite-hub/vitehub",
    }, async () => undefined, { signal: controller.signal })).rejects.toMatchObject({ code: "ABORT_ERR" })
    expect((await readdir(tmpdir())).filter(path => path.startsWith(prefix) && !before.has(path))).toEqual([])
  })

  it.each(["abort", "timeout"] as const)("cancels the checkout callback on %s", async (control) => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_HEAD_SHA = "expected-head"
    const host = createGitHubHost({ credentials: () => ({ token: "token" }) })
    const controller = new AbortController()
    let callbackStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve
    })

    const checkout = host.withPullRequestCheckout({
      headSha: "expected-head",
      number: 126,
      repository: "vite-hub/vitehub",
    }, async ({ signal }) => await new Promise((_resolve, reject) => {
      callbackStarted?.()
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }), { signal: controller.signal })
    await started
    if (control === "abort") {
      controller.abort(new Error("callback cancelled"))
    }
    else {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"))
    }
    await expect(checkout).rejects.toThrow(
      control === "abort" ? "callback cancelled" : "timed out",
    )
  })
})

describe("Agent Invocation host recovery", () => {
  it("fails only interrupted active invocations", async () => {
    const store = createMemoryAgentInvocationStore()
    const create = (id: string, status: "completed" | "pending" | "running", createdAt: string) => store.create({
      createdAt,
      id,
      observations: [],
      status,
      traceId: `trace-${id}`,
      updatedAt: createdAt,
    })
    create("old-pending", "pending", "2026-08-30T10:00:00.000Z")
    create("new-running", "running", "2026-08-30T12:00:00.000Z")
    create("completed", "completed", "2026-08-30T09:00:00.000Z")

    await expect(failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      recover: () => true,
    })).resolves.toBe(1)
    await expect(Promise.resolve(store.get("old-pending"))).resolves.toMatchObject({
      error: { message: "The host stopped before this Agent Invocation finished." },
      status: "failed",
    })
    await expect(Promise.resolve(store.get("new-running"))).resolves.toMatchObject({ status: "running" })
  })

  it("recovers every page without taking work claimed by another host", async () => {
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    for (let index = 0; index < 101; index += 1) {
      store.create({
        createdAt,
        id: `old-${index}`,
        observations: [],
        status: "running",
        traceId: `trace-${index}`,
        updatedAt: createdAt,
      })
    }
    await store.claim("old-100", "live-host", 60_000)

    await expect(failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      limit: 25,
      recover: invocation => invocation.id !== "provider-owned",
    })).resolves.toBe(100)
    await expect(Promise.resolve(store.get("old-0"))).resolves.toMatchObject({ status: "failed" })
    await expect(Promise.resolve(store.get("old-100"))).resolves.toMatchObject({ status: "running" })
  })

  it("excludes provider-owned durable work from process recovery", async () => {
    const store = createMemoryAgentInvocationStore()
    const createdAt = "2026-08-30T10:00:00.000Z"
    store.create({ createdAt, id: "host-owned", observations: [], status: "running", traceId: "host", updatedAt: createdAt })
    store.create({ createdAt, id: "provider-owned", observations: [], status: "running", traceId: "provider", updatedAt: createdAt })

    await expect(failInterruptedAgentInvocations(store, {
      before: Date.parse("2026-08-30T11:00:00.000Z"),
      recover: invocation => invocation.id === "host-owned",
    })).resolves.toBe(1)
    await expect(Promise.resolve(store.get("provider-owned"))).resolves.toMatchObject({ status: "running" })
  })

  it("summarizes current and stale work", () => {
    expect(summarizeAgentInvocationWorkload([
      { createdAt: "2026-08-30T09:00:00.000Z", status: "running" },
      { createdAt: "2026-08-30T11:00:00.000Z", status: "pending" },
      { createdAt: "2026-08-30T08:00:00.000Z", status: "completed" },
      { createdAt: "2026-08-30T08:00:00.000Z", status: "failed" },
      { createdAt: "2026-08-30T08:00:00.000Z", status: "cancelled" },
    ], Date.parse("2026-08-30T10:00:00.000Z"))).toEqual({
      active: 1,
      completed: 1,
      failed: 1,
      stale: 1,
      total: 5,
    })
  })
})
