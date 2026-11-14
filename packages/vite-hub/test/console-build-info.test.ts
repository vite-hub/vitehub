import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { collectConsoleBuild } from "../src/console/build-info.ts"

const now = () => new Date("2026-11-14T10:00:00.000Z")
const sha = "4f9c2e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f"
const noGit = () => undefined

describe("collectConsoleBuild", () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  it("reads the commit, message, author, and branch of a Vercel build", () => {
    const env = {
      VERCEL_GIT_COMMIT_AUTHOR_NAME: "Ada Lovelace",
      VERCEL_GIT_COMMIT_MESSAGE: "feat: add the ferry schedule\n\nLonger body that the Console does not show.",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_SHA: sha.toUpperCase(),
    }
    expect(collectConsoleBuild({ cwd: "/app", env, git: noGit, now })).toEqual({
      commit: { author: "Ada Lovelace", branch: "main", message: "feat: add the ferry schedule", sha },
      time: "2026-11-14T10:00:00.000Z",
    })
  })

  it("fills the message and author of a CI commit from git when the SHAs match", () => {
    const calls: string[][] = []
    const git = (args: readonly string[]) => {
      calls.push([...args])
      return args[0] === "log" ? `${sha}\0fix: keep the ferry times\0Grace Hopper\n` : undefined
    }
    const build = collectConsoleBuild({ cwd: "/app", env: { GITHUB_REF_NAME: "release", GITHUB_SHA: sha }, git, now })
    expect(build.commit).toEqual({ author: "Grace Hopper", branch: "release", message: "fix: keep the ferry times", sha })
    expect(calls).toEqual([["log", "-1", "--format=%H%x00%s%x00%an", sha]])
  })

  it("prefers the pull request branch of GitHub Actions", () => {
    const build = collectConsoleBuild({ cwd: "/app", env: { GITHUB_HEAD_REF: "feat/ferry", GITHUB_REF_NAME: "12/merge", GITHUB_SHA: sha }, git: noGit, now })
    expect(build.commit).toEqual({ branch: "feat/ferry", sha })
  })

  it("keeps the CI commit when git knows another HEAD", () => {
    const git = (args: readonly string[]) => args[0] === "log" ? `${"a".repeat(40)}\0other\0Someone\n` : "main\n"
    expect(collectConsoleBuild({ cwd: "/app", env: { WORKERS_CI_BRANCH: "main", WORKERS_CI_COMMIT_SHA: sha }, git, now }).commit).toEqual({ branch: "main", sha })
  })

  it("reads git when no CI variable names a commit, and leaves out a detached HEAD", () => {
    const git = (args: readonly string[]) => args[0] === "log" ? `${sha}\0chore: tidy\0Maxi\n` : "HEAD\n"
    expect(collectConsoleBuild({ cwd: "/app", env: {}, git, now }).commit).toEqual({ author: "Maxi", message: "chore: tidy", sha })
  })

  it("records only the time without git, and ignores a value that is not a SHA", () => {
    expect(collectConsoleBuild({ cwd: "/app", env: { GITHUB_SHA: "not-a-sha" }, git: noGit, now })).toEqual({ time: "2026-11-14T10:00:00.000Z" })
  })

  it("uses SOURCE_DATE_EPOCH for a reproducible build", () => {
    expect(collectConsoleBuild({ cwd: "/app", env: { SOURCE_DATE_EPOCH: "1700000000" }, git: noGit, now }).time).toBe("2023-11-14T22:13:20.000Z")
  })

  it("shortens a long subject", () => {
    const build = collectConsoleBuild({ cwd: "/app", env: { VERCEL_GIT_COMMIT_MESSAGE: "x".repeat(300), VERCEL_GIT_COMMIT_SHA: sha }, git: noGit, now })
    expect(build.commit?.message).toHaveLength(200)
    expect(build.commit?.message?.endsWith("…")).toBe(true)
  })

  it("runs git in a real repository, and does not fail outside one", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-build-info-"))
    roots.push(root)
    expect(collectConsoleBuild({ cwd: root, env: {}, now })).toEqual({ time: "2026-11-14T10:00:00.000Z" })
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim()
    git("init", "-q", "-b", "deploys")
    await writeFile(join(root, "a.txt"), "a")
    git("add", "a.txt")
    git("-c", "user.name=Joy", "-c", "user.email=joy@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "docs: add the guide")
    expect(collectConsoleBuild({ cwd: root, env: {}, now }).commit).toEqual({ author: "Joy", branch: "deploys", message: "docs: add the guide", sha: git("rev-parse", "HEAD") })
  })
})
