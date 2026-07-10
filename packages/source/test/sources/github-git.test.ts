import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { getGitSparsePatterns, loadGitCheckoutFiles } from "../../src/sources/github/git.ts"

describe("@vite-hub/source GitHub git materialization", () => {
  it("checks out and reads simple sparse source paths without putting auth in git arguments", async () => {
    const calls: Array<{ args: string[], options: { env?: NodeJS.ProcessEnv, signal?: AbortSignal } }> = []
    let sparseCheckout = ""
    const signal = new AbortController().signal
    const runGit: NonNullable<Parameters<typeof loadGitCheckoutFiles>[1]> = async (args, options = {}) => {
      calls.push({ args, options })
      const dir = args[0] === "-C" ? args[1] : undefined
      if (args[2] === "fetch" && dir) {
        sparseCheckout = await readFile(join(dir, ".git", "info", "sparse-checkout"), "utf8")
      }
      if (args[2] === "checkout" && dir) {
        await writeCheckoutFile(dir, "server/workspaces/mirror/data/tasks.jsonl", "{\"id\":1}\n")
        await writeCheckoutFile(dir, "server/workspaces/mirror/docs/guide.md", "# Guide\n")
        await writeCheckoutFile(dir, "server/workspaces/mirror/docs/private.md", "# Private\n")
        await writeCheckoutFile(dir, "outside.md", "outside\n")
      }
      return args[2] === "rev-parse" ? "checkout-sha\n" : ""
    }

    const files = await loadGitCheckoutFiles({
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
        content: Buffer.from("{\"id\":1}\n"),
        key: "data/tasks.jsonl",
        path: "data/tasks.jsonl",
        ref: "main",
        sha: "checkout-sha",
      },
      {
        content: Buffer.from("# Guide\n"),
        key: "docs/guide.md",
        path: "docs/guide.md",
        ref: "main",
        sha: "checkout-sha",
      },
    ])
    expect(sparseCheckout).toBe([
      "/server/workspaces/mirror/data/tasks.jsonl",
      "/server/workspaces/mirror/docs/**",
      "",
    ].join("\n"))
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
    const credentialIndex = Number(env?.GIT_CONFIG_COUNT) - 1
    expect(env?.[`GIT_CONFIG_VALUE_${credentialIndex}`]).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:github-token").toString("base64")}`,
    )
    expect(calls.map(call => call.args)).toContainEqual([
      "-C",
      expect.any(String),
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      "+main",
    ])
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
    const runGit: NonNullable<Parameters<typeof loadGitCheckoutFiles>[1]> = async (args) => {
      checkoutDir = args.at(-1)
      controller.abort()
      throw controller.signal.reason
    }

    await expect(loadGitCheckoutFiles({
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
})

async function writeCheckoutFile(dir: string, path: string, content: string) {
  const file = join(dir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}
