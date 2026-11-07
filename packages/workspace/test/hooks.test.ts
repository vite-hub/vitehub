import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { pushedBranches, workspaceHooksNamespace } from "../src/hooks-cli.ts"

const exec = promisify(execFile)
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
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

async function run(name: string, rootDir: string, input = "") {
  let stdout = ""
  let stderr = ""
  const namespace = workspaceHooksNamespace({ readInput: async () => input })
  const code = await namespace.features.find(feature => feature.name === name)!.run([], {
    cwd: rootDir,
    env: {},
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
    const husky = await run("install", rootDir)
    expect(husky).toMatchObject({ code: 0, stdout: expect.stringContaining("Husky runs the Git hooks of this repository") })
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

  it("pushes the checkout folders only when Git pushes the default branch", async () => {
    const { rootDir } = await repository()
    await writeFile(join(rootDir, "vitehub.lock"), JSON.stringify({ version: 1, workspaces: { site: { dir: "content", files: {}, head: "r1", ref: "draft", remote: "https://docs.example.test" } } }))

    expect(await run("pre-push", rootDir, "refs/heads/feature 1 refs/heads/feature 0\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("does not update main") })
    // The push reaches the remote, which is not there, so the hook fails and Git stops.
    const failed = await run("pre-push", rootDir, "refs/heads/main 1 refs/heads/main 0\n")
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain("the Workspace push failed, so Git stops this push")
  })

  it("reads the remote branches from the pre-push input", () => {
    expect(pushedBranches("refs/heads/a 1 refs/heads/main 0\nrefs/tags/v1 2 refs/tags/v1 0\n")).toEqual(["main"])
    expect(pushedBranches("")).toEqual([])
  })
})
