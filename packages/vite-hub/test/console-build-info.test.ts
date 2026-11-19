import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { collectConsoleBuild } from "../src/console/build-info.ts"
import { consoleCompareUrl } from "../src/console/runtime/client/project-link.ts"

const now = () => new Date("2026-11-14T10:00:00.000Z")
const sha = "4f9c2e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f"
const noGit = async () => undefined

describe("collectConsoleBuild", () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  it("reads the commit, message, author, branch, and repository of a Vercel build", async () => {
    const env = {
      VERCEL_GIT_COMMIT_AUTHOR_NAME: "Ada Lovelace",
      VERCEL_GIT_COMMIT_MESSAGE: "feat: add the ferry schedule\n\nLonger body that the Console does not show.",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_SHA: sha.toUpperCase(),
      VERCEL_GIT_PROVIDER: "github",
      VERCEL_GIT_REPO_OWNER: "ferries",
      VERCEL_GIT_REPO_SLUG: "timetable",
    }
    expect(await collectConsoleBuild({ cwd: "/app", env, git: noGit, now })).toEqual({
      commit: { author: "Ada Lovelace", branch: "main", message: "feat: add the ferry schedule", repository: "ferries/timetable", sha },
      time: "2026-11-14T10:00:00.000Z",
    })
  })

  it("fills the message and author of a CI commit from git when the SHAs match", async () => {
    const calls: string[][] = []
    const git = async (args: string[]) => {
      calls.push([...args])
      return args[0] === "log" ? `${sha}\0fix: keep the ferry times\0Grace Hopper` : undefined
    }
    const build = await collectConsoleBuild({ cwd: "/app", env: { GITHUB_REF_NAME: "release", GITHUB_REPOSITORY: "ferries/timetable", GITHUB_SHA: sha }, git, now })
    expect(build.commit).toEqual({ author: "Grace Hopper", branch: "release", message: "fix: keep the ferry times", repository: "ferries/timetable", sha })
    expect(calls).toEqual([["log", "-1", "--format=%H%x00%s%x00%an%x00%ae", sha]])
  })

  it("records the GitHub login of the author from Vercel, a GitHub Actions push, or a noreply email", async () => {
    const vercel = { VERCEL_GIT_COMMIT_AUTHOR_LOGIN: "ada", VERCEL_GIT_COMMIT_AUTHOR_NAME: "Ada", VERCEL_GIT_COMMIT_MESSAGE: "feat: ship", VERCEL_GIT_COMMIT_SHA: sha }
    expect((await collectConsoleBuild({ cwd: "/app", env: { ...vercel, VERCEL_GIT_PROVIDER: "github" }, git: noGit, now })).commit?.login).toBe("ada")
    // A GitLab login has no GitHub avatar.
    expect((await collectConsoleBuild({ cwd: "/app", env: { ...vercel, VERCEL_GIT_PROVIDER: "gitlab" }, git: noGit, now })).commit).not.toHaveProperty("login")

    const root = await mkdtemp(join(tmpdir(), "vitehub-build-event-"))
    roots.push(root)
    const event = join(root, "event.json")
    await writeFile(event, JSON.stringify({ head_commit: { author: { name: "Grace Hopper", username: "grace" }, id: sha } }))
    const push = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, GITHUB_SHA: sha }
    expect((await collectConsoleBuild({ cwd: "/app", env: push, git: noGit, now })).commit?.login).toBe("grace")
    await writeFile(event, JSON.stringify({ head_commit: { author: { username: "grace" }, id: "a".repeat(40) } }))
    expect((await collectConsoleBuild({ cwd: "/app", env: push, git: noGit, now })).commit).not.toHaveProperty("login")

    const noreply = (email: string) => async (args: string[]) => args[0] === "log" ? `${sha}\0fix: x\0Joy\0${email}` : undefined
    const login = async (email: string) => (await collectConsoleBuild({ cwd: "/app", env: { GITHUB_SHA: sha }, git: noreply(email), now })).commit?.login
    expect(await login("12345+joy-dev@users.noreply.github.com")).toBe("joy-dev")
    expect(await login("12345+mona-cat_octo@users.noreply.github.com")).toBe("mona-cat_octo")
    expect(await login("joy@users.noreply.github.com")).toBe("joy")
    expect(await login("joy@example.com")).toBeUndefined()
    expect(await login("49699333+dependabot[bot]@users.noreply.github.com")).toBeUndefined()
  })

  it("prefers the pull request branch of GitHub Actions", async () => {
    const build = await collectConsoleBuild({ cwd: "/app", env: { GITHUB_HEAD_REF: "feat/ferry", GITHUB_REF_NAME: "12/merge", GITHUB_SHA: sha }, git: noGit, now })
    expect(build.commit).toEqual({ branch: "feat/ferry", sha })
  })

  it("keeps the CI commit when git knows another HEAD", async () => {
    const git = async (args: string[]) => args[0] === "log" ? `${"a".repeat(40)}\0other\0Someone` : "main"
    expect((await collectConsoleBuild({ cwd: "/app", env: { WORKERS_CI_BRANCH: "main", WORKERS_CI_COMMIT_SHA: sha }, git, now })).commit).toEqual({ branch: "main", sha })
  })

  it("reads git when no CI variable names a commit, and leaves out a detached HEAD and a remote off github.com", async () => {
    const answers: Record<string, string> = {
      "log": `${sha}\0chore: tidy\0Maxi`,
      "rev-parse HEAD": sha,
      "rev-parse --abbrev-ref HEAD": "HEAD",
      "remote get-url origin": "https://gitlab.com/ferries/timetable.git",
    }
    const git = async (args: string[]) => answers[args[0] === "log" ? "log" : args.join(" ")]
    expect((await collectConsoleBuild({ cwd: "/app", env: {}, git, now })).commit).toEqual({ author: "Maxi", message: "chore: tidy", sha })
  })

  it("records only the time without git, and ignores a value that is not a SHA", async () => {
    expect(await collectConsoleBuild({ cwd: "/app", env: { GITHUB_SHA: "not-a-sha" }, git: noGit, now })).toEqual({ time: "2026-11-14T10:00:00.000Z" })
  })

  it("uses SOURCE_DATE_EPOCH for a reproducible build", async () => {
    expect((await collectConsoleBuild({ cwd: "/app", env: { SOURCE_DATE_EPOCH: "1700000000" }, git: noGit, now })).time).toBe("2023-11-14T22:13:20.000Z")
  })

  it("shortens a long subject", async () => {
    const build = await collectConsoleBuild({ cwd: "/app", env: { VERCEL_GIT_COMMIT_MESSAGE: "x".repeat(300), VERCEL_GIT_COMMIT_SHA: sha }, git: noGit, now })
    expect(build.commit?.message).toHaveLength(200)
    expect(build.commit?.message?.endsWith("…")).toBe(true)
  })

  it("runs git in a real repository, and does not fail outside one", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-build-info-"))
    roots.push(root)
    expect(await collectConsoleBuild({ cwd: root, env: {}, now })).toEqual({ time: "2026-11-14T10:00:00.000Z" })
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim()
    git("init", "-q", "-b", "deploys")
    git("remote", "add", "origin", "git@github.com:ferries/timetable.git")
    await writeFile(join(root, "a.txt"), "a")
    git("add", "a.txt")
    git("-c", "user.name=Joy", "-c", "user.email=joy@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "docs: add the guide")
    expect((await collectConsoleBuild({ cwd: root, env: {}, now })).commit).toEqual({ author: "Joy", branch: "deploys", message: "docs: add the guide", repository: "ferries/timetable", sha: git("rev-parse", "HEAD") })
  })
})

describe("consoleCompareUrl", () => {
  it("compares the deployed commit with the default branch of its GitHub repository", () => {
    expect(consoleCompareUrl({ time: "2026-11-14T10:00:00.000Z", commit: { repository: "ferries/timetable", sha } }))
      .toBe(`https://github.com/ferries/timetable/compare/${sha}...HEAD`)
    expect(consoleCompareUrl({ time: "2026-11-14T10:00:00.000Z", commit: { sha } })).toBeUndefined()
    expect(consoleCompareUrl(undefined)).toBeUndefined()
  })
})
