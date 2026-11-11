import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "../src/blob-database.ts"
import { workspaceCheckoutFeatures } from "../src/checkout-cli.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { pushedBranches, workspaceHooksNamespace } from "../src/hooks-cli.ts"
import { useWorkspace } from "../src/index.ts"
import { workspaceOperations } from "../src/operations.ts"
import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

/** The paths that `readdir` and `readFile` opened, to check what the hooks read. */
const opened = vi.hoisted((): string[] => [])

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  const readdir = async (...args: Parameters<typeof fs.readdir>) => {
    opened.push(String(args[0]))
    return await fs.readdir(...args)
  }
  const readFile = async (...args: Parameters<typeof fs.readFile>) => {
    opened.push(String(args[0]))
    return await fs.readFile(...args)
  }
  return { ...fs, readdir: readdir as typeof fs.readdir, readFile: readFile as typeof fs.readFile }
})

const exec = promisify(execFile)
const cleanup: Array<() => Promise<void>> = []
const pushMain = "refs/heads/main 1 refs/heads/main 0\n"

afterEach(async () => {
  resetWorkspaceRegistry()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** A Git repository with the ViteHub project in `docs/`, or in another folder. */
async function repository(project = "docs") {
  const top = await mkdtemp(join(tmpdir(), "vitehub-hooks-"))
  cleanup.push(() => rm(top, { force: true, recursive: true }))
  await exec("git", ["init", "-q", "-b", "main", top], { env: { ...process.env, LC_ALL: "C" } })
  const rootDir = join(top, project)
  await mkdir(rootDir, { recursive: true })
  return { rootDir, top }
}

/** A deployed app with the `content` Workspace, reached through the operation RPC, as in checkout.test.ts. */
async function app() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-hooks-app-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(async () => client.close())
  const database = drizzle({ client: client })
  const migration = await readFile(new URL("fixtures/history.sql", import.meta.url), "utf8")
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const store = createBlobDatabaseWorkspaceStore({ blob: createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") })), database, workspace: "content" })
  registerWorkspace("content", { store })
  const { history } = useWorkspace("content", { definition: { name: "content", store }, mode: "write" })
  const registry = createOperationRegistry([{ operations: workspaceOperations }])
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const { input, operation } = operationRpcRequest(init!.body)
    const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    return operationRpcResponse(init!.body, result)
  }
  const edit = async (put: Record<string, string>) => {
    const head = await history.head({ ref: "draft" })
    return await history.commit({ ref: "draft", ifHead: head?.id ?? null, changes: { put }, message: "Console edit" })
  }
  return { edit, fetch: fetch as typeof globalThis.fetch, history }
}

async function run(name: string, rootDir: string, input = "", fetch?: typeof globalThis.fetch, args: string[] = []) {
  let stdout = ""
  let stderr = ""
  const namespace = workspaceHooksNamespace({ readInput: async () => input })
  const features = [...namespace.features, ...workspaceCheckoutFeatures()]
  const code = await features.find(feature => feature.name === name)!.run(args, {
    cwd: rootDir,
    env: {},
    ...(fetch ? { fetch } : {}),
    rootDir,
    stderr: { write: (chunk) => { stderr += String(chunk) } },
    stdout: { write: (chunk) => { stdout += String(chunk) } },
  })
  return { code, stderr, stdout }
}

describe("vitehub hooks", () => {
  it("writes pre-commit and pre-push hooks that run from the project folder, and removes only its own", async () => {
    const { rootDir, top } = await repository()

    expect(await run("install", rootDir)).toMatchObject({ code: 0, stdout: "Wrote .git/hooks/pre-commit\nWrote .git/hooks/pre-push\n" })

    const hook = await readFile(join(top, ".git/hooks/pre-push"), "utf8")
    expect(hook).toContain(`cd "$(git rev-parse --show-toplevel)"/'docs' || exit 1`)
    expect(hook).toContain(`exec node_modules/.bin/vitehub hooks pre-push "$@"`)
    expect((await stat(join(top, ".git/hooks/pre-commit"))).mode & 0o111).toBe(0o111)
    expect((await run("install", rootDir)).code).toBe(0)

    await writeFile(join(top, ".git/hooks/post-merge"), "#!/bin/sh\necho mine\n")
    expect(await run("uninstall", rootDir)).toMatchObject({ code: 0, stdout: "Removed pre-commit\nRemoved pre-push\n" })
    expect(await readFile(join(top, ".git/hooks/post-merge"), "utf8")).toBe("#!/bin/sh\necho mine\n")
  })

  it("keeps a hook that it did not write, and prints the commands for a hook manager", async () => {
    const { rootDir, top } = await repository()
    await mkdir(join(top, ".git/hooks"), { recursive: true })
    await writeFile(join(top, ".git/hooks/pre-commit"), "#!/bin/sh\nnpm test\n")

    const kept = await run("install", rootDir)

    expect(kept.code).toBe(1)
    expect(kept.stderr).toContain("These hooks exist and are not the hooks that ViteHub writes: pre-commit.")
    expect(kept.stderr).toContain("pre-commit: cd 'docs' && vitehub hooks pre-commit")
    expect(await readFile(join(top, ".git/hooks/pre-commit"), "utf8")).toBe("#!/bin/sh\nnpm test\n")

    await mkdir(join(top, ".husky"))
    await exec("git", ["config", "core.hooksPath", ".husky/_"], { cwd: top })
    const husky = await run("install", rootDir)
    expect(husky).toMatchObject({ code: 0, stdout: expect.stringContaining("Husky runs the Git hooks of this repository") })
  })

  it("installs hooks when a leftover Husky folder is not configured", async () => {
    const { rootDir, top } = await repository()
    await mkdir(join(top, ".husky"))

    expect(await run("install", rootDir)).toMatchObject({ code: 0, stdout: "Wrote .git/hooks/pre-commit\nWrote .git/hooks/pre-push\n" })
    for (const hook of ["pre-commit", "pre-push"]) {
      expect(await readFile(join(top, ".git/hooks", hook), "utf8")).toContain(`vitehub hooks ${hook}`)
    }
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["pre-commit", "pre-push"])("preserves an unreadable %s on install and uninstall", async (hook) => {
    const { rootDir, top } = await repository()
    const path = join(top, ".git/hooks", hook)
    const content = "#!/bin/sh\nnpm test\n"
    await writeFile(path, content)

    for (const command of ["install", "uninstall"]) {
      await chmod(path, 0o200)
      const result = await run(command, rootDir).finally(async () => await chmod(path, 0o600))
      expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining("EACCES") })
      expect(await readFile(path, "utf8")).toBe(content)
    }
  })

  it("keeps a hook to which you added commands, on install and on uninstall", async () => {
    const { rootDir, top } = await repository()
    await run("install", rootDir)
    const preCommit = join(top, ".git/hooks/pre-commit")
    const changed = `${await readFile(preCommit, "utf8")}npm test\n`
    await writeFile(preCommit, changed)

    const installed = await run("install", rootDir)
    expect(installed.code).toBe(1)
    expect(installed.stderr).toContain("are not the hooks that ViteHub writes: pre-commit.")
    expect(await readFile(preCommit, "utf8")).toBe(changed)

    expect(await run("uninstall", rootDir)).toMatchObject({ code: 0, stdout: "Left pre-commit: it is not the hook that `vitehub hooks install` writes, so it can contain your commands.\nRemoved pre-push\n" })
    expect(await readFile(preCommit, "utf8")).toBe(changed)
  })

  it("quotes a project folder with a space and a quote in the hook and in the printed commands", async () => {
    const project = "docs site/it's"
    const { rootDir, top } = await repository(project)
    // A stand-in for the vitehub binary that prints the folder it runs in and its arguments.
    const bin = join(top, "bin")
    await mkdir(bin)
    for (const dir of [bin, join(rootDir, "node_modules/.bin")]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "vitehub"), "#!/bin/sh\necho \"$PWD $*\"\n", { mode: 0o755 })
    }
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }

    await run("install", rootDir)
    expect((await exec("sh", [join(top, ".git/hooks/pre-commit")], { cwd: top, env })).stdout).toBe(`${rootDir} hooks pre-commit\n`)

    await rm(join(top, ".git/hooks/pre-commit"))
    await rm(join(top, ".git/hooks/pre-push"))
    await mkdir(join(top, ".husky"))
    await exec("git", ["config", "core.hooksPath", ".husky/_"], { cwd: top })
    const printed = (await run("install", rootDir)).stdout
    const command = printed.match(/pre-commit: (.+)\n/)![1]!
    expect(command).toBe(`cd 'docs site/it'\\''s' && vitehub hooks pre-commit`)
    expect((await exec("sh", ["-c", command], { cwd: top, env })).stdout).toBe(`${rootDir} hooks pre-commit\n`)
  })

  it("does nothing without vitehub.lock, and stops a commit while a checkout folder has conflicts", async () => {
    const { rootDir } = await repository()
    expect(await run("pre-commit", rootDir)).toMatchObject({ code: 0, stdout: "" })
    expect(await run("pre-push", rootDir, "refs/heads/main 1 refs/heads/main 0\n")).toMatchObject({ code: 0, stdout: "" })

    await writeFile(join(rootDir, "vitehub.lock"), JSON.stringify({ version: 1, workspaces: { site: { dir: "content", files: {}, head: "r1", ref: "draft" } } }))
    await mkdir(join(rootDir, "content"))
    await writeFile(join(rootDir, "content/guide.md"), "<<<<<<< local\na\n=======\nb\n>>>>>>> draft r2\n")

    const blocked = await run("pre-commit", rootDir)
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain("a checkout folder has conflicts, so Git stops this commit")
  })

  it.each(["", "docs site/it's"])("checks the staged checkout files when the working tree is resolved, in project %j", async (project) => {
    const { rootDir } = await repository(project)
    await writeFile(join(rootDir, "vitehub.lock"), JSON.stringify({ version: 1, workspaces: { site: { dir: "content", files: {}, head: "r1", ref: "draft" } } }))
    await mkdir(join(rootDir, "content/posts"), { recursive: true })
    const path = "content/posts/guide with space.md"
    const conflict = "<<<<<<< local\na\n=======\nb\n>>>>>>> draft r2\n"
    await writeFile(join(rootDir, path), conflict)
    await exec("git", ["add", "--", path], { cwd: rootDir })
    await writeFile(join(rootDir, path), "Resolved\n")

    const blocked = await run("pre-commit", rootDir)

    expect(blocked).toMatchObject({ code: 1, stderr: expect.stringContaining("  conflict  posts/guide with space.md\n") })
    expect(blocked.stderr).toContain("a checkout folder has conflicts, so Git stops this commit")
    expect((await exec("git", ["show", `:./${path}`], { cwd: rootDir })).stdout).toBe(conflict)

    await exec("git", ["add", "--", path], { cwd: rootDir })
    expect(await run("pre-commit", rootDir)).toMatchObject({ code: 0, stderr: "" })
    // A staged deletion has no blob left to check.
    await exec("git", ["rm", "--cached", "--", path], { cwd: rootDir })
    expect(await run("pre-commit", rootDir)).toMatchObject({ code: 0, stderr: "" })
  })

  it("checks only checkout paths in the index, while retaining binary conflicts from the lock", async () => {
    const { rootDir } = await repository()
    const lock = { version: 1, workspaces: { site: { dir: "content", files: {}, head: "r1", ref: "draft", conflicts: [] as string[] } } }
    await writeFile(join(rootDir, "vitehub.lock"), JSON.stringify(lock))
    const conflict = "<<<<<<< local\na\n=======\nb\n>>>>>>> draft r2\n"
    for (const dir of ["content/Node_Modules", "content-copy"]) {
      await mkdir(join(rootDir, dir), { recursive: true })
      await writeFile(join(rootDir, dir, "guide.md"), conflict)
      await exec("git", ["add", "-f", "--", `${dir}/guide.md`], { cwd: rootDir })
    }
    // Marker-like text in documentation is not a complete conflict.
    await writeFile(join(rootDir, "content/guide.md"), "<<<<<<< local\nExample\n")
    await exec("git", ["add", "--", "content/guide.md"], { cwd: rootDir })
    expect(await run("pre-commit", rootDir)).toMatchObject({ code: 0, stderr: "" })

    lock.workspaces.site.conflicts.push("image.png")
    await writeFile(join(rootDir, "vitehub.lock"), JSON.stringify(lock))
    expect(await run("pre-commit", rootDir)).toMatchObject({ code: 1, stderr: expect.stringContaining("  conflict  image.png\n") })
  })

  it("pushes the checkout folders only when Git pushes the default branch", async () => {
    const { rootDir } = await repository()
    await writeFile(join(rootDir, "vitehub.lock"), JSON.stringify({ version: 1, workspaces: { site: { dir: "content", files: {}, head: "r1", ref: "draft", remote: "https://docs.example.test" } } }))

    expect(await run("pre-push", rootDir, "refs/heads/feature 1 refs/heads/feature 0\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("does not update main") })
    // Deleting the default branch on the remote pushes no commit.
    const zero = "0".repeat(40)
    expect(await run("pre-push", rootDir, `(delete) ${zero} refs/heads/main ${"a".repeat(40)}\n`)).toMatchObject({ code: 0, stdout: expect.stringContaining("does not update main") })
    // The push reaches the remote, which is not there, so the hook fails and Git stops.
    const failed = await run("pre-push", rootDir, "refs/heads/main 1 refs/heads/main 0\n")
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain("the Workspace push failed, so Git stops this push")
  })

  it("fails the Git push after a Workspace push that changes vitehub.lock or pulls files, and passes the next push", { timeout: 60_000 }, async () => {
    const remoteApp = await app()
    await remoteApp.edit({ "posts/hello.md": "Hello\n", "posts/other.md": "Other\n" })
    const { rootDir } = await repository()
    expect((await run("pull", rootDir, "", remoteApp.fetch, ["content", "--dir", "content", "--ref", "draft", "--url", "https://docs.example.test"])).code).toBe(0)
    const lock = await readFile(join(rootDir, "vitehub.lock"), "utf8")

    await remoteApp.edit({ "posts/other.md": "Other, edited in the Console\n" })
    await writeFile(join(rootDir, "content/posts/hello.md"), "Hello, edited locally\n")
    const pushed = await run("pre-push", rootDir, "refs/heads/main 1 refs/heads/main 0\n", remoteApp.fetch)

    expect(pushed.code).toBe(1)
    expect(pushed.stderr).toBe("vitehub: the Workspace push went through and changed these files:\n  content/posts/other.md\n  vitehub.lock\nGit stops this push because it does not contain them. Commit them, then run git push again.\n")
    expect(await readFile(join(rootDir, "vitehub.lock"), "utf8")).not.toBe(lock)
    expect(await readFile(join(rootDir, "content/posts/other.md"), "utf8")).toBe("Other, edited in the Console\n")
    const head = await remoteApp.history.head({ ref: "draft" })
    expect(await (await remoteApp.history.open(head!.id)).readFile("posts/hello.md", { encoding: "utf8" })).toBe("Hello, edited locally\n")

    expect(await run("pre-push", rootDir, "refs/heads/main 1 refs/heads/main 0\n", remoteApp.fetch)).toMatchObject({ code: 0, stderr: "" })
  })

  it.skipIf(process.getuid?.() === 0)("does not read the folders that a checkout skips, in any letter case", { timeout: 60_000 }, async () => {
    const remoteApp = await app()
    await remoteApp.edit({ "posts/hello.md": "Hello\n" })
    const { rootDir } = await repository()
    await run("pull", rootDir, "", remoteApp.fetch, ["content", "--dir", "content", "--ref", "draft", "--url", "https://docs.example.test"])
    // A folder that the hook cannot read stands in for a large dependency folder.
    const skipped = join(rootDir, "content/Node_Modules")
    await mkdir(join(skipped, "pkg"), { recursive: true })
    await writeFile(join(skipped, "pkg/index.js"), "export {}\n")
    await chmod(skipped, 0)
    cleanup.push(() => chmod(skipped, 0o755))
    await remoteApp.edit({ "posts/other.md": "Other\n" })
    opened.length = 0

    const pushed = await run("pre-push", rootDir, pushMain, remoteApp.fetch)

    expect(pushed.stderr).toContain("changed these files:\n  content/posts/other.md\n  vitehub.lock\n")
    expect(opened.filter(path => path.startsWith(skipped))).toEqual([])
  })

  it("reads no folder outside the project that a committed lock names", async () => {
    const { rootDir, top } = await repository()
    const outside = join(top, "secret")
    await mkdir(outside)
    await writeFile(join(outside, "key.pem"), "secret\n")
    await writeFile(join(rootDir, "vitehub.lock"), JSON.stringify({ version: 1, workspaces: { site: { dir: "../secret", files: {}, head: "r1", ref: "draft", remote: "https://docs.example.test" } } }))
    opened.length = 0

    const pushed = await run("pre-push", rootDir, pushMain)

    expect(pushed.code).toBe(1)
    expect(pushed.stderr).toContain("must be a folder inside the project")
    expect(opened.filter(path => path.startsWith(outside))).toEqual([])
  })

  it("reads no folder outside the project through a link at or above a checkout folder, or inside it", async () => {
    const { rootDir, top } = await repository()
    const outside = join(top, "secret")
    await mkdir(outside)
    await writeFile(join(outside, "key.pem"), "secret\n")
    const lock = (dir: string) => JSON.stringify({ version: 1, workspaces: { site: { dir, files: {}, head: "r1", ref: "draft", remote: "https://docs.example.test" } } })

    for (const [link, dir] of [["content", "content"], ["linked", "linked/content"]] as const) {
      await rm(join(rootDir, link), { force: true, recursive: true })
      await symlink(outside, join(rootDir, link))
      await writeFile(join(rootDir, "vitehub.lock"), lock(dir))
      opened.length = 0

      const pushed = await run("pre-push", rootDir, pushMain)

      expect(pushed).toMatchObject({ code: 1, stderr: `WORKSPACE_CHECKOUT_SYMLINK: ${link} is a symbolic link. A checkout reads and writes only real files and folders.\nReplace the link with a real folder or file, then try again.\n` })
      expect(opened.filter(path => path.startsWith(join(rootDir, link)))).toEqual([])
      await rm(join(rootDir, link))
    }

    await mkdir(join(rootDir, "content"))
    await symlink(outside, join(rootDir, "content/leak"))
    await writeFile(join(rootDir, "vitehub.lock"), lock("content"))
    opened.length = 0

    const pushed = await run("pre-push", rootDir, pushMain)

    expect(pushed).toMatchObject({ code: 1, stderr: expect.stringContaining("WORKSPACE_CHECKOUT_SYMLINK: content/leak in the checkout folder is a symbolic link.") })
    expect(opened.filter(path => path.startsWith(join(rootDir, "content/leak")))).toEqual([])
  })

  it("fails both hooks when vitehub.lock exists but cannot be read", async () => {
    const { rootDir } = await repository()
    await mkdir(join(rootDir, "vitehub.lock"))

    for (const hook of ["pre-commit", "pre-push"]) {
      const failed = await run(hook, rootDir, pushMain)
      expect(failed.code).toBe(1)
      expect(failed.stderr).toContain("EISDIR")
    }
  })

  it("reads the remote branches from the pre-push input", () => {
    expect(pushedBranches("refs/heads/a 1 refs/heads/main 0\nrefs/tags/v1 2 refs/tags/v1 0\n")).toEqual(["main"])
    expect(pushedBranches("")).toEqual([])
    expect(pushedBranches(`(delete) ${"0".repeat(40)} refs/heads/main ${"a".repeat(40)}\nrefs/heads/b ${"0".repeat(64)} refs/heads/old 1\n`)).toEqual([])
  })
})
