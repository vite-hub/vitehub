import { Buffer } from "node:buffer"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"

import { forgeAccessKey, forgeGitEnvironment } from "../src/internal/forge-access.ts"
import { preparePullRequestCheckout, pullRequestCheckoutPlan, pullRequestRepositories } from "../src/internal/pull-request-checkout.ts"
import type { AgentCallbackContext } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra }
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = cleanEnv()): Promise<string> {
  return (await execFileAsync("git", args, { cwd, env })).stdout.trim()
}

/** A GitHub stand-in: `https://github.com/` resolves to local bare repositories through Git URL rewriting. */
async function githubFixture() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-pr-checkout-"))
  fixtures.push(root)
  const remotes = join(root, "remotes")
  const bare = join(remotes, "vite-hub", "vitehub.git")
  const seed = join(root, "seed")
  const workspace = join(root, "workspace")
  await mkdir(bare, { recursive: true })
  await mkdir(seed)
  await mkdir(workspace)
  await git(bare, ["init", "-q", "--bare"])
  await git(seed, ["init", "-q", "-b", "main"])
  await writeFile(join(seed, "README.md"), "main\n")
  await git(seed, ["add", "README.md"])
  await git(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "main"])
  await git(seed, ["checkout", "-q", "-b", "feature"])
  await writeFile(join(seed, "README.md"), "feature\n")
  await git(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qam", "feature"])
  const headSha = await git(seed, ["rev-parse", "HEAD"])
  await git(seed, ["push", "-q", bare, "main", "feature", "feature:refs/pull/42/head"])
  // The same shape as createGitHubHost().access().env: Git config through the environment only.
  const env = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  }
  const session = {
    async exec(command: string, args: string[] = [], options: { cwd?: string, env?: Record<string, string> } = {}) {
      const cwd = (options.cwd || "/workspace").replace(/^\/workspace/, workspace)
      try {
        const result = await execFileAsync(command, args, { cwd, env: cleanEnv(options.env) })
        return { args, command, exitCode: 0, stderr: result.stderr, stdout: result.stdout }
      }
      catch (error) {
        const failure = error as { code?: number, stderr?: string, stdout?: string }
        return { args, command, exitCode: typeof failure.code === "number" ? failure.code : 1, stderr: failure.stderr || "", stdout: failure.stdout || "" }
      }
    },
  }
  return { bare, env, headSha, session, workspace }
}

describe("pull request checkout", () => {
  it("keeps the pull request repositories when the managed checkout is disabled", () => {
    const store = (pullRequest: Record<string, unknown>) => ({ get: () => ({ pullRequest, repository: { fullName: "vite-hub/vitehub", name: "vitehub" } }) })
    const disabled = store({
      head: { ref: "feature", repo: "contributor/vitehub", sha: "a".repeat(40) },
      source: { checkout: false, ref: "feature", repo: "vite-hub/vitehub" },
    })
    expect(pullRequestCheckoutPlan(disabled)).toBeUndefined()
    expect(pullRequestRepositories(disabled)).toEqual({ headRepository: "contributor/vitehub", repository: "vite-hub/vitehub" })
    expect(pullRequestRepositories(store({ source: { checkout: false } }))).toEqual({ repository: "vite-hub/vitehub" })
    expect(pullRequestRepositories({ get: () => ({ provider: "gitlab", pullRequest: { source: { repo: "vite-hub/vitehub" } } }) })).toBeUndefined()
    expect(pullRequestRepositories(undefined)).toBeUndefined()
  })

  it("reads repository scope from the Babysitter input context without planning a checkout", () => {
    const values = new Map<string, unknown>([
      ["pullRequestRepository", "vite-hub/vitehub"],
      ["pullRequestSourceRepository", "contributor/vitehub"],
    ])
    const context = { get: (key: string) => values.get(key) }
    expect(pullRequestCheckoutPlan(context)).toBeUndefined()
    expect(pullRequestRepositories(context)).toEqual({ headRepository: "contributor/vitehub", repository: "vite-hub/vitehub" })
    values.set("pullRequestSourceRepository", "VITE-HUB/VITEHUB")
    expect(pullRequestRepositories(context)).toEqual({ repository: "vite-hub/vitehub" })
    values.set("pullRequestSourceRepository", "(unavailable)")
    expect(pullRequestRepositories(context)).toEqual({ repository: "vite-hub/vitehub" })
    values.set("pullRequestRepository", "invalid repository")
    expect(pullRequestRepositories(context)).toBeUndefined()
  })

  it.each(["", "vitehub"])("rejects a deleted fork head before preparing the %j mount", async (mount) => {
    const fixture = await githubFixture()
    const exec = vi.spyOn(fixture.session, "exec")
    const checkout = async () => {
      const plan = pullRequestCheckoutPlan({
        get: () => ({
          pullRequest: {
            head: { ref: "feature", sha: fixture.headSha },
            source: { mount, ref: "refs/pull/42/head", repo: "vite-hub/vitehub" },
          },
        }),
      })
      await preparePullRequestCheckout(fixture.session, plan!, { env: fixture.env })
    }
    await expect(checkout()).rejects.toThrow("requires an explicit head repository")
    expect(exec).not.toHaveBeenCalled()
    expect(await git(fixture.bare, ["rev-parse", "refs/heads/feature"])).toBe(fixture.headSha)
  })

  it("sends base and fork credentials only to their own remote URLs", async () => {
    const fixture = await githubFixture()
    const access = vi.fn(async (_context: AgentCallbackContext, scope: { repository: string }) => scope.repository === "contributor/vitehub" ? "fork-token" : "base-token")
    const signal = new AbortController().signal
    const context = { memo: (_key: string, create: () => unknown) => create(), runtime: "unknown" } as never
    const env = cleanEnv(await forgeGitEnvironment(context, { [forgeAccessKey]: access }, { repository: "vite-hub/vitehub", headRepository: "contributor/vitehub" }, signal))
    expect(access.mock.calls.map(([, scope]) => scope)).toEqual([
      { repository: "vite-hub/vitehub", signal },
      { repository: "contributor/vitehub", signal },
    ])
    expect(env.GH_TOKEN).toBe("base-token")
    const header = async (url: string) => await git(fixture.workspace, ["config", "--get-urlmatch", "http.extraheader", url], env).catch(() => "")
    const basic = (token: string) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
    expect(await header("https://github.com/vite-hub/vitehub.git/info/refs")).toBe(basic("base-token"))
    expect(await header("https://github.com/vite-hub/vitehub/info/refs")).toBe(basic("base-token"))
    expect(await header("https://github.com/contributor/vitehub.git/git-receive-pack")).toBe(basic("fork-token"))
    expect(await header("https://github.com/other/vitehub.git/info/refs")).toBe("")
    expect(await header("https://example.com/vite-hub/vitehub.git/info/refs")).toBe("")
  })

  it("has no Git credentials without forge access or a repository", async () => {
    const context = { memo: (_key: string, create: () => unknown) => create(), runtime: "unknown" } as never
    const access = vi.fn(async () => "token")
    expect(await forgeGitEnvironment(context, {}, { repository: "vite-hub/vitehub" })).toEqual({})
    expect(await forgeGitEnvironment(context, { [forgeAccessKey]: access }, undefined)).toEqual({})
    expect(access).not.toHaveBeenCalled()
  })

  it("creates a real checkout that can fetch, commit, and push with the forge access environment", async () => {
    const fixture = await githubFixture()
    const plan = pullRequestCheckoutPlan({
      get: () => ({
        pullRequest: {
          base: { ref: "main" },
          head: { ref: "feature", repo: "vite-hub/vitehub", sha: fixture.headSha },
          number: 42,
          source: { mount: "vitehub", ref: "refs/pull/42/head", repo: "vite-hub/vitehub" },
        },
        repository: { fullName: "vite-hub/vitehub", name: "vitehub" },
      }),
    })
    expect(plan).toMatchObject({ headBranch: "feature", mount: "vitehub", repository: "vite-hub/vitehub" })

    await expect(preparePullRequestCheckout(fixture.session, plan!, { env: fixture.env })).resolves.toBe(true)

    const checkout = join(fixture.workspace, "vitehub")
    const env = cleanEnv(fixture.env)
    expect(await git(checkout, ["rev-parse", "HEAD"])).toBe(fixture.headSha)
    expect(await git(checkout, ["branch", "--show-current"])).toBe("feature")
    expect(await git(checkout, ["remote", "get-url", "origin"])).toBe("https://github.com/vite-hub/vitehub.git")
    expect(await git(checkout, ["config", "--local", "--get-regexp", "extraheader"]).catch(() => "")).toBe("")

    await expect(preparePullRequestCheckout(fixture.session, plan!, { env: fixture.env })).resolves.toBe(false)
    await git(checkout, ["remote", "set-url", "origin", "https://github.com/other/repository.git"])
    await expect(preparePullRequestCheckout(fixture.session, plan!, { env: fixture.env })).rejects.toThrow("wrong origin remote")
    await git(checkout, ["remote", "set-url", "origin", "https://github.com/vite-hub/vitehub.git"])

    await git(checkout, ["fetch", "-q", "origin", "main"], env)
    await writeFile(join(checkout, "CHANGE.md"), "agent\n")
    await git(checkout, ["add", "CHANGE.md"])
    await git(checkout, ["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-qm", "agent change"])
    await git(checkout, ["push", "-q"], env)

    expect(await git(fixture.bare, ["rev-parse", "refs/heads/feature"])).toBe(await git(checkout, ["rev-parse", "HEAD"]))
    await expect(preparePullRequestCheckout(fixture.session, { ...plan!, headSha: fixture.headSha }, { env: fixture.env })).rejects.toThrow("does not match the expected SHA")
  })

  it("tracks the fork remote for default pushes while retaining origin fetches", async () => {
    const fixture = await githubFixture()
    const fork = join(fixture.workspace, "..", "remotes", "contributor", "vitehub.git")
    await mkdir(join(fork, ".."), { recursive: true })
    await git(fixture.workspace, ["clone", "-q", "--bare", fixture.bare, fork])
    await preparePullRequestCheckout(fixture.session, {
      baseRef: "refs/heads/main",
      headBranch: "feature",
      headRef: "refs/pull/42/head",
      headRepository: "contributor/vitehub",
      headSha: fixture.headSha,
      mount: "vitehub",
      repository: "vite-hub/vitehub",
    }, { env: fixture.env })
    const checkout = join(fixture.workspace, "vitehub")
    const env = cleanEnv(fixture.env)
    expect(await git(checkout, ["remote", "get-url", "origin"])).toBe("https://github.com/vite-hub/vitehub.git")
    expect(await git(checkout, ["config", "branch.feature.remote"])).toBe("head")
    await git(checkout, ["fetch", "-q", "origin", "main"], env)
    await writeFile(join(checkout, "CHANGE.md"), "fork change\n")
    await git(checkout, ["add", "CHANGE.md"])
    await git(checkout, ["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-qm", "fork change"])
    await git(checkout, ["push", "-q"], env)
    expect(await git(fork, ["rev-parse", "refs/heads/feature"])).toBe(await git(checkout, ["rev-parse", "HEAD"]))
    expect(await git(fixture.bare, ["rev-parse", "refs/heads/feature"])).toBe(fixture.headSha)
  })

  it.each([false, true].flatMap(forked => [
    "HEAD:refs/heads/feature",
    "refs/heads/feature:refs/heads/feature",
    "feature",
    "refs/heads/feature",
    "HEAD",
    "feature:feature",
    "feature:refs/heads/feature",
    "refs/heads/feature:feature",
    "HEAD:feature",
  ].map(refspec => [forked, refspec] as const)))("reuses the GitHub host checkout with fork %s and refspec %s", async (forked, refspec) => {
    const fixture = await githubFixture()
    const headRepository = forked ? "contributor/vitehub" : "vite-hub/vitehub"
    const headBare = forked ? join(fixture.workspace, "..", "remotes", "contributor", "vitehub.git") : fixture.bare
    if (forked) {
      await mkdir(join(headBare, ".."), { recursive: true })
      await git(fixture.workspace, ["clone", "-q", "--bare", fixture.bare, headBare])
    }
    const env = cleanEnv(fixture.env)
    const checkout = join(fixture.workspace, "vitehub")
    // Match createGitHubHost(): origin fetches the base, origin pushes the head,
    // and the local head branch has an explicit push refspec without an upstream.
    await git(fixture.workspace, ["clone", "-q", "--no-checkout", "https://github.com/vite-hub/vitehub.git", "vitehub"], env)
    await git(checkout, ["fetch", "-q", "--no-tags", `https://github.com/${headRepository}.git`, "refs/heads/feature"], env)
    await git(checkout, ["checkout", "-q", "-B", "feature", "FETCH_HEAD"])
    await git(checkout, ["remote", "set-url", "--push", "origin", `https://github.com/${headRepository}.git`])
    // Source-only and explicit forms must push to the same verified head branch.
    await git(checkout, ["config", "remote.origin.push", refspec])
    expect(await git(checkout, ["config", "branch.feature.remote"]).catch(() => "")).toBe("")
    expect(await git(checkout, ["remote"])).toBe("origin")

    await expect(preparePullRequestCheckout(fixture.session, {
      headBranch: "feature",
      headRef: "refs/pull/42/head",
      ...(forked ? { headRepository } : {}),
      headSha: fixture.headSha,
      mount: "vitehub",
      repository: "vite-hub/vitehub",
    }, { env: fixture.env })).resolves.toBe(false)

    await writeFile(join(checkout, "CHANGE.md"), "host checkout change\n")
    await git(checkout, ["add", "CHANGE.md"])
    await git(checkout, ["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-qm", "host checkout change"])
    await git(checkout, ["push", "-q"], env)
    expect(await git(headBare, ["rev-parse", "refs/heads/feature"])).toBe(await git(checkout, ["rev-parse", "HEAD"]))
    if (forked) expect(await git(fixture.bare, ["rev-parse", "refs/heads/feature"])).toBe(fixture.headSha)
  })

  it("reuses a GitHub host checkout with pushes disabled without enabling them", async () => {
    const fixture = await githubFixture()
    const env = cleanEnv(fixture.env)
    const checkout = join(fixture.workspace, "vitehub")
    await git(fixture.workspace, ["clone", "-q", "--no-checkout", "https://github.com/vite-hub/vitehub.git", "vitehub"], env)
    await git(checkout, ["fetch", "-q", "origin", "refs/heads/feature"], env)
    await git(checkout, ["checkout", "-q", "-B", "feature", "FETCH_HEAD"])
    const disabled = "disabled://pull-request-head-repository-unavailable"
    await git(checkout, ["remote", "set-url", "--push", "origin", disabled])

    await expect(preparePullRequestCheckout(fixture.session, {
      headBranch: "feature",
      headRef: "refs/pull/42/head",
      headSha: fixture.headSha,
      mount: "vitehub",
      repository: "vite-hub/vitehub",
    }, { env: fixture.env })).resolves.toBe(false)
    expect(await git(checkout, ["remote", "get-url", "--push", "origin"])).toBe(disabled)
    await writeFile(join(checkout, "CHANGE.md"), "read-only host checkout\n")
    await git(checkout, ["add", "CHANGE.md"])
    await git(checkout, ["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-qm", "local change"])
    await expect(git(checkout, ["push", "-q", "origin", "HEAD:refs/heads/feature"], env)).rejects.toThrow()
    expect(await git(fixture.bare, ["rev-parse", "refs/heads/feature"])).toBe(fixture.headSha)
  })

  it.each([
    ["remote.origin.pushurl", "https://github.com/other/repository.git", "wrong push destination"],
    ["remote.origin.push", "HEAD:refs/heads/other", "wrong push refspec"],
    ["remote.origin.push", "feature:other", "wrong push refspec"],
    ["remote.origin.push", "+feature", "wrong push refspec"],
    ["remote.origin.push", "+feature:other", "wrong push refspec"],
    ["remote.origin.mirror", "true", "wrong push refspec"],
    ["push.default", "matching", "wrong default push configuration"],
    ["branch.feature.pushRemote", "other", "wrong push remote"],
  ] as const)("rejects a reused checkout with %s=%s", async (key, value, message) => {
    const fixture = await githubFixture()
    const plan = {
      headBranch: "feature",
      headRef: "refs/pull/42/head",
      headSha: fixture.headSha,
      mount: "vitehub",
      repository: "vite-hub/vitehub",
    }
    await preparePullRequestCheckout(fixture.session, plan, { env: fixture.env })
    await git(join(fixture.workspace, "vitehub"), ["config", key, value])
    await expect(preparePullRequestCheckout(fixture.session, plan, { env: fixture.env })).rejects.toThrow(message)
  })

  it("rejects a fetched head that differs from the webhook SHA", async () => {
    const fixture = await githubFixture()
    await expect(preparePullRequestCheckout(fixture.session, {
      headRef: "refs/pull/42/head",
      headSha: "b".repeat(40),
      mount: "vitehub",
      repository: "vite-hub/vitehub",
    }, { env: fixture.env })).rejects.toThrow("fetched pull request head does not match the expected SHA")
  })
})
