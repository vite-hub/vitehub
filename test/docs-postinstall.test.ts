import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const root = new URL("..", import.meta.url)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

/** A PATH with `vp` and `nuxi` scripts that log their call and exit with the given codes. */
async function fakeTools(exitCodes: { nuxi: number, vp: number }): Promise<{ calls: () => Promise<string[]>, path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-docs-postinstall-"))
  temporaryDirectories.push(directory)
  const log = join(directory, "calls.log")
  const windows = process.platform === "win32"
  for (const [name, code] of Object.entries(exitCodes)) {
    const tool = join(directory, windows ? `${name}.cmd` : name)
    await writeFile(tool, windows
      ? `@echo off\r\n>> "${log}" echo ${name}\r\nexit /b ${code}\r\n`
      : `#!/bin/sh\necho ${name} >> "${log}"\nexit ${code}\n`)
    if (!windows) await chmod(tool, 0o755)
  }
  return {
    calls: async () => (await readFile(log, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean),
    path: directory,
  }
}

function postinstall(env: Record<string, string | undefined>) {
  const { CI: _ci, VITEHUB_SKIP_DOCS_PREPARE: _skip, npm_command: _command, ...inherited } = process.env
  for (const key of Object.keys(inherited)) {
    if (key.toLowerCase() === "path") delete inherited[key]
  }
  return spawnSync(process.execPath, ["docs/scripts/postinstall.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...inherited, ...env },
  })
}

describe("docs postinstall", () => {
  it("skips the docs build and nuxi prepare when CI opts out", () => {
    const result = postinstall({ PATH: "", VITEHUB_SKIP_DOCS_PREPARE: "1" })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Skipping the docs build and nuxi prepare")
  })

  it("keeps a local install green when a package build fails, and says how to retry", async () => {
    const tools = await fakeTools({ nuxi: 0, vp: 1 })
    const result = postinstall({ npm_command: "install", PATH: tools.path })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain("failed (exit code 1)")
    expect(result.stderr).toContain("corepack pnpm --dir docs run postinstall")
    // nuxi prepare needs the built packages, so it does not run after a failed build.
    expect(await tools.calls()).toEqual(["vp"])
  })

  it("fails the install in CI when a package build fails", async () => {
    const tools = await fakeTools({ nuxi: 0, vp: 1 })
    const result = postinstall({ CI: "true", npm_command: "install", PATH: tools.path })
    expect(result.status).toBe(1)
    expect(await tools.calls()).toEqual(["vp"])
  })

  it("propagates a failed nuxi prepare when explicitly retried outside CI", async () => {
    const tools = await fakeTools({ nuxi: 7, vp: 0 })
    const result = postinstall({ npm_command: "run-script", PATH: tools.path })
    expect(result.status, result.stderr).toBe(7)
    expect(await tools.calls()).toEqual(["vp", "nuxi"])
  })

  it("runs the build and nuxi prepare when both pass", async () => {
    const tools = await fakeTools({ nuxi: 0, vp: 0 })
    const result = postinstall({ PATH: tools.path })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).not.toContain("[vitehub]")
    expect(await tools.calls()).toEqual(["vp", "nuxi"])
  })
})
