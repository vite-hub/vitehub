import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"

import { preparePullRequestCheckout, pullRequestCheckoutEnvironment, pullRequestCheckoutPlan } from "../src/internal/pull-request-checkout.ts"

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

  it("selects base and fork credentials by remote URL without persisting tokens", async () => {
    const fixture = await githubFixture()
    const access = vi.fn(async (input?: { repository?: string }) => {
      const token = input?.repository === "contributor/vitehub" ? "fork-token" : "base-token"
      return {
        env: {
          GH_TOKEN: token,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_VALUE_1: '!f() { printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f',
        },
        token,
      }
    })
    const signal = new AbortController().signal
    const env = cleanEnv(await pullRequestCheckoutEnvironment({ access }, "vite-hub/vitehub", signal, "contributor/vitehub"))
    expect(access.mock.calls).toEqual([
      [{ repository: "vite-hub/vitehub", signal }],
      [{ repository: "contributor/vitehub", signal }],
    ])
    expect(env.GH_TOKEN).toBe("base-token")
    const fill = async (repository: string) => {
      return await new Promise<string>((resolve, reject) => {
        const process = execFile("git", ["credential", "fill"], { cwd: fixture.workspace, env }, (error, stdout) => {
          if (error) reject(error)
          else resolve(stdout)
        })
        process.stdin?.end(`protocol=https\nhost=github.com\npath=${repository}\n\n`)
      })
    }
    expect(await fill("vite-hub/vitehub.git")).toContain("password=base-token")
    expect(await fill("contributor/vitehub.git")).toContain("password=fork-token")
    expect(await fill("contributor/vitehub")).toContain("password=fork-token")
    expect(await fill("other/vitehub.git")).toContain("password=base-token")
    expect(Object.entries(env).filter(([key]) => key.startsWith("GIT_CONFIG_VALUE_")).map(([, value]) => value).join("\n")).not.toMatch(/base-token|fork-token/)
  })

  it("creates a real checkout that can fetch, commit, and push with the Agent GitHub environment", async () => {
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
