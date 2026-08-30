import { generateKeyPairSync } from "node:crypto"
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createGitHubHost,
  createMemoryAgentInvocationStore,
  failInterruptedAgentInvocations,
  parseGraphQLRateLimit,
  summarizeAgentInvocationWorkload,
} from "../src/server.ts"

const originalPath = process.env.PATH
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  vi.unstubAllGlobals()
  process.env.PATH = originalPath
  delete process.env.VITEHUB_TEST_HEAD_SHA
  await Promise.all([...temporaryDirectories].map(path => rm(path, { force: true, recursive: true })))
  temporaryDirectories.clear()
})

async function installFakeGitHubCommands(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-host-test-"))
  temporaryDirectories.add(root)
  await Promise.all([
    writeFile(join(root, "gh"), `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "rate_limit" ]; then
  printf '%s\\n' '{"resources":{"graphql":{"remaining":100,"reset":2000000000}}}'
fi
`, { mode: 0o755 }),
    writeFile(join(root, "git"), `#!/bin/sh
case "$*" in
  *"rev-parse HEAD"*) printf '%s\\n' "$VITEHUB_TEST_HEAD_SHA" ;;
esac
`, { mode: 0o755 }),
  ])
  await Promise.all([chmod(join(root, "gh"), 0o755), chmod(join(root, "git"), 0o755)])
  process.env.PATH = `${root}:${originalPath}`
}

describe("GitHub host", () => {
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

  it("admits GraphQL work against a shared reserve", async () => {
    await installFakeGitHubCommands()
    const host = createGitHubHost({ credentials: () => ({ token: "token" }), reserve: 1_500 })

    let failure: unknown
    try {
      await host.ensureGraphQLBudget("vite-hub/vitehub")
    }
    catch (error) {
      failure = error
    }

    expect(host.isRateLimitError(failure)).toBe(true)
    expect(host.budget()).toEqual({ limited: true, remaining: 100, resetAt: 2_000_000_000_000 })
  })

  it("verifies the exact pull-request head and removes the temporary checkout", async () => {
    await installFakeGitHubCommands()
    process.env.VITEHUB_TEST_HEAD_SHA = "expected-head"
    const host = createGitHubHost({ credentials: () => ({ token: "token" }) })
    let checkout = ""

    await expect(host.withPullRequestCheckout({
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
    })).resolves.toBe(1)
    await expect(Promise.resolve(store.get("old-pending"))).resolves.toMatchObject({
      error: { message: "The host stopped before this Agent Invocation finished." },
      status: "failed",
    })
    await expect(Promise.resolve(store.get("new-running"))).resolves.toMatchObject({ status: "running" })
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
