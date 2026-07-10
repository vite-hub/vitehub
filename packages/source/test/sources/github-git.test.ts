import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { getGitSparsePatterns, loadGitArchiveFiles } from "../../src/sources/github/git.ts"
import { createTarGz } from "./fixtures/github.ts"

describe("@vite-hub/source GitHub git materialization", () => {
  it("archives simple sparse source paths without putting auth in git arguments", async () => {
    const calls: Array<{
      args: string[]
      options: { env?: NodeJS.ProcessEnv, signal?: AbortSignal }
    }> = []
    const signal = new AbortController().signal
    const runGit: NonNullable<Parameters<typeof loadGitArchiveFiles>[1]> = async (args, options = {}) => {
      calls.push({ args, options })
      if (args[2] === "rev-parse") return "checkout-sha\n"
      if (args[2] === "archive") {
        return createTarGz({
          "server/workspaces/mirror/data/tasks.jsonl": "{\"id\":1}\n",
          "server/workspaces/mirror/docs/guide.md": "# Guide\n",
          "server/workspaces/mirror/docs/private.md": "private\n",
        })
      }
      return ""
    }

    const files = await loadGitArchiveFiles({
      env: {
        ...process.env,
        GIT_COMMON_DIR: "/outside/common",
        GIT_DIR: "/outside/repository",
        GIT_INDEX_FILE: "/outside/index",
        GIT_WORK_TREE: "/outside/worktree",
      },
      keyForRepoPath(path) {
        const root = "server/workspaces/mirror/"
        return path.startsWith(root) ? path.slice(root.length) : undefined
      },
      ref: "main",
      repo: "acme/private",
      shouldInclude: key => key !== "docs/private.md",
      signal,
      sparsePatterns: [
        "server/workspaces/mirror/data/tasks.jsonl",
        "server/workspaces/mirror/docs/**",
      ],
      token: "github-token",
    }, runGit)

    expect(files).toEqual([
      {
        content: new Uint8Array(Buffer.from("{\"id\":1}\n")),
        key: "data/tasks.jsonl",
        path: "data/tasks.jsonl",
        ref: "main",
        sha: "checkout-sha",
      },
      {
        content: new Uint8Array(Buffer.from("# Guide\n")),
        key: "docs/guide.md",
        path: "docs/guide.md",
        ref: "main",
        sha: "checkout-sha",
      },
    ])
    expect(calls.map(call => call.args)).toContainEqual([
      "-C",
      expect.any(String),
      "remote",
      "add",
      "origin",
      "https://github.com/acme/private.git",
    ])
    expect(calls.every(call => call.options.signal === signal)).toBe(true)
    expect(JSON.stringify(calls.map(call => call.args))).not.toContain("github-token")
    const env = calls[0]?.options.env
    expect(env?.GIT_CONFIG_COUNT).toBe("1")
    expect(env?.GIT_CONFIG_GLOBAL).toBe(devNull)
    expect(env?.GIT_CONFIG_NOSYSTEM).toBe("1")
    expect(env?.GIT_TERMINAL_PROMPT).toBe("0")
    expect(env?.GIT_COMMON_DIR).toBeUndefined()
    expect(env?.GIT_DIR).toBeUndefined()
    expect(env?.GIT_INDEX_FILE).toBeUndefined()
    expect(env?.GIT_WORK_TREE).toBeUndefined()
    expect(env?.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:github-token").toString("base64")}`,
    )
    expect(calls.map(call => call.args)).toContainEqual([
      "-C",
      expect.any(String),
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "--",
      "origin",
      "+main",
    ])
    expect(calls.map(call => call.args)).toContainEqual([
      "-C",
      expect.any(String),
      "archive",
      "--format=tar.gz",
      "--prefix=archive/",
      "checkout-sha",
      "--",
      ":(literal)server/workspaces/mirror/data/tasks.jsonl",
      ":(literal)server/workspaces/mirror/docs",
    ])
    expect(calls.some(call => call.args.includes("checkout"))).toBe(false)
  })

  it("only accepts sparse patterns that preserve Source include semantics", () => {
    expect(getGitSparsePatterns("docs", undefined)).toEqual(["docs/**"])
    expect(getGitSparsePatterns("docs", "/README.md")).toEqual(["docs/README.md"])
    expect(getGitSparsePatterns("", ["README.md", "docs/**", "docs/**"])).toEqual(["README.md", "docs/**"])
    expect(getGitSparsePatterns("dbt", ["models/**/*.sql"])).toBeUndefined()
    expect(getGitSparsePatterns("", ["src/*.{ts,tsx}"])).toBeUndefined()
    expect(getGitSparsePatterns("", ["docs/**\noutside/**"])).toBeUndefined()
    expect(getGitSparsePatterns("", undefined)).toBeUndefined()
  })

  it("propagates aborts and removes the temporary checkout", async () => {
    const controller = new AbortController()
    let checkoutDir: string | undefined
    const runGit: NonNullable<Parameters<typeof loadGitArchiveFiles>[1]> = async (args) => {
      checkoutDir = args.at(-1)
      controller.abort()
      throw controller.signal.reason
    }

    await expect(loadGitArchiveFiles({
      keyForRepoPath: path => path,
      ref: "main",
      repo: "acme/app",
      shouldInclude: () => true,
      signal: controller.signal,
      sparsePatterns: ["docs/**"],
    }, runGit)).rejects.toMatchObject({ name: "AbortError" })

    if (!checkoutDir) throw new Error("Expected git init to receive the temporary checkout path.")
    await expect(access(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("honors Git archive attributes without running ambient smudge filters", async () => {
    const fixture = await createGitRemote()
    const marker = join(fixture.root, "smudge-ran")
    try {
      const files = await loadGitArchiveFiles({
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "filter.danger.smudge",
          GIT_CONFIG_KEY_1: "filter.danger.required",
          GIT_CONFIG_VALUE_0: `touch ${marker}; cat`,
          GIT_CONFIG_VALUE_1: "true",
        },
        keyForRepoPath: path => path,
        ref: "main",
        repo: "local/fixture",
        repositoryUrl: fixture.remote,
        shouldInclude: () => true,
        sparsePatterns: ["docs/**"],
      })

      expect(files.map(file => [file.path, Buffer.from(file.content || [])])).toEqual([
        ["docs/filter.dat", Buffer.from("original\n")],
        ["docs/lines.txt", Buffer.from("line one\r\nline two\r\n")],
        ["docs/template.txt", Buffer.from(`${fixture.sha}\r\n`)],
      ])
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  it("treats selected Source paths beginning with a colon as literal Git paths", async () => {
    const fixture = await createGitRemote()
    try {
      const files = await loadGitArchiveFiles({
        keyForRepoPath: path => path,
        ref: "main",
        repo: "local/fixture",
        repositoryUrl: fixture.remote,
        shouldInclude: () => true,
        sparsePatterns: [":README.md", ":/README.md"],
      })

      expect(files.map(file => [file.path, Buffer.from(file.content || []).toString("utf8")])).toEqual([
        [":/README.md", "nested colon\n"],
        [":README.md", "colon\n"],
      ])
    }
    finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  it("falls back instead of returning a Git LFS pointer", async () => {
    const fixture = await createGitRemote()
    try {
      await expect(loadGitArchiveFiles({
        keyForRepoPath: path => path,
        ref: "main",
        repo: "local/fixture",
        repositoryUrl: fixture.remote,
        shouldInclude: () => true,
        sparsePatterns: ["assets/**"],
      })).rejects.toThrow("Git LFS pointer")
    }
    finally {
      await rm(fixture.root, { force: true, recursive: true })
    }
  })

  it("does not send ambient Git credentials when no Source token is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-git-auth-test-"))
    const helperMarker = join(root, "credential-helper-ran")
    const requests: Array<Record<string, string | string[] | undefined>> = []
    const server = createServer((request, response) => {
      requests.push(request.headers)
      response.writeHead(401, { "WWW-Authenticate": "Basic realm=fixture" })
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected an HTTP fixture port.")

    try {
      await expect(loadGitArchiveFiles({
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_KEY_1: "credential.helper",
          GIT_CONFIG_VALUE_0: "X-Ambient-Credential: secret",
          GIT_CONFIG_VALUE_1: `!touch ${helperMarker}`,
        },
        keyForRepoPath: path => path,
        ref: "main",
        repo: "local/auth-fixture",
        repositoryUrl: `http://127.0.0.1:${address.port}/repo.git`,
        shouldInclude: () => true,
        sparsePatterns: ["README.md"],
      })).rejects.toThrow("git fetch exited")

      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every(headers => headers["x-ambient-credential"] === undefined)).toBe(true)
      expect(requests.every(headers => headers.authorization === undefined)).toBe(true)
      await expect(access(helperMarker)).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { force: true, recursive: true })
    }
  })
})

async function createGitRemote() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-git-bytes-test-"))
  const source = join(root, "source")
  const remote = join(root, "remote.git")
  const execute = promisify(execFile)
  await mkdir(join(source, "docs"), { recursive: true })
  await mkdir(join(source, "assets"), { recursive: true })
  await mkdir(join(source, ":"), { recursive: true })
  await execute("git", ["init", "--quiet", "--initial-branch=main", source])
  await execute("git", ["-C", source, "config", "user.email", "fixture@example.com"])
  await execute("git", ["-C", source, "config", "user.name", "Fixture"])
  await writeFile(join(source, ".gitattributes"), [
    "*.txt text eol=crlf",
    "*.dat filter=danger",
    "docs/private.md export-ignore",
    "docs/template.txt export-subst",
    "assets/*.bin filter=lfs diff=lfs merge=lfs -text",
    "",
  ].join("\n"))
  await writeFile(join(source, "assets", "large.bin"), [
    "version https://git-lfs.github.com/spec/v1",
    `oid sha256:${"a".repeat(64)}`,
    "size 1234",
    "",
  ].join("\n"))
  await writeFile(join(source, "docs", "filter.dat"), "original\n")
  await writeFile(join(source, "docs", "lines.txt"), "line one\nline two\n")
  await writeFile(join(source, "docs", "private.md"), "private\n")
  await writeFile(join(source, "docs", "template.txt"), "$Format:%H$\n")
  await writeFile(join(source, ":README.md"), "colon\n")
  await writeFile(join(source, ":", "README.md"), "nested colon\n")
  await execute("git", ["-C", source, "add", "."])
  await execute("git", ["-C", source, "commit", "--quiet", "-m", "fixture"])
  const { stdout } = await execute("git", ["-C", source, "rev-parse", "HEAD"])
  const sha = stdout.trim()
  await execute("git", ["clone", "--quiet", "--bare", source, remote])
  await execute("git", ["--git-dir", remote, "config", "uploadpack.allowFilter", "true"])
  return { remote, root, sha }
}
