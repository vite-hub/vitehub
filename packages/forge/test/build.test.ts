import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildMetaContent, parseBuildMeta } from "../src/build.ts"
import { githubRepository, readForgeBuild } from "../src/build/node.ts"

const sha = "9b31f0e2c4d6a8b0c2e4f6a8b0c2d4e6f8a0b2c4"

describe("build identity", () => {
  it("writes and reads the meta tag content", () => {
    const content = buildMetaContent({ repository: "acme/app", commit: sha.toUpperCase(), branch: "main", pullRequest: 12 })
    expect(content).toBe(JSON.stringify({ repository: "acme/app", commit: sha }))
    expect(parseBuildMeta(content)).toEqual({ repository: "acme/app", commit: sha })
  })

  it.each([
    [undefined],
    [""],
    ["not json"],
    ["null"],
    [JSON.stringify({ repository: "acme/app" })],
    [JSON.stringify({ repository: "acme/app", commit: "9b31f0e" })],
    [JSON.stringify({ repository: "acme", commit: sha })],
    [JSON.stringify({ repository: "acme/app/x", commit: sha })],
    [JSON.stringify({ repository: "acme/app", commit: 42 })],
  ])("rejects %s", (content) => {
    expect(parseBuildMeta(content)).toBeUndefined()
  })

  it("has no content without a repository and a full commit", () => {
    expect(buildMetaContent({ commit: sha })).toBeUndefined()
    expect(buildMetaContent({ repository: "acme/app", commit: "9b31f0e" })).toBeUndefined()
  })
})

describe("readForgeBuild", () => {
  const empty = mkdtempSync(join(tmpdir(), "forge-build-"))

  it("prefers the VITEHUB_BUILD_ variables over CI variables", async () => {
    const build = await readForgeBuild(empty, {
      VITEHUB_BUILD_COMMIT: sha,
      VITEHUB_BUILD_BRANCH: "feature",
      VITEHUB_BUILD_REPOSITORY: "acme/app",
      GITHUB_SHA: "1".repeat(40),
      GITHUB_REPOSITORY: "acme/other",
    })
    expect(build).toEqual({ commit: sha, branch: "feature", repository: "acme/app" })
  })

  it("reads GitHub Actions and the pull request of the ref", async () => {
    const build = await readForgeBuild(empty, { GITHUB_SHA: sha, GITHUB_HEAD_REF: "feature", GITHUB_REPOSITORY: "acme/app", GITHUB_REF: "refs/pull/12/merge" })
    expect(build).toEqual({ commit: sha, branch: "feature", repository: "acme/app", pullRequest: 12 })
  })

  it("falls back to Git", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-build-git-"))
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, encoding: "utf8" }).trim()
    git("init", "-q", "-b", "main")
    git("remote", "add", "origin", "git@github.com:acme/app.git")
    git("commit", "-q", "--allow-empty", "-m", "init")
    expect(await readForgeBuild(root, {})).toEqual({ commit: git("rev-parse", "HEAD"), branch: "main", repository: "acme/app" })
  })

  it("names the repository of a remote", () => {
    expect(githubRepository("https://github.com/acme/app.git")).toBe("acme/app")
    expect(githubRepository("not a remote")).toBeUndefined()
  })
})
