import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { resolveCodexRuntimePackages, resolveInstalledCodexExecutable } from "../src/internal/codex-runtime-package.ts"

const tempDirs: string[] = []

async function createProject(options: { platformPackage?: boolean } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-codex-runtime-"))
  tempDirs.push(rootDir)
  await writeFile(join(rootDir, "package.json"), "{}\n")
  const packageDir = join(rootDir, "node_modules", "@openai", "codex")
  await mkdir(join(packageDir, "bin"), { recursive: true })
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.149.1" }))
  await writeFile(join(packageDir, "bin", "codex.js"), "#!/usr/bin/env node\n")
  if (options.platformPackage) {
    const platformPackageDir = join(rootDir, "node_modules", "@openai", "codex-linux-x64")
    await mkdir(platformPackageDir, { recursive: true })
    await writeFile(join(platformPackageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.149.1-linux-x64" }))
  }
  return { packageDir, rootDir }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Codex runtime package", () => {
  it("uses an installed Codex CLI and selects only the deployment platform package", async () => {
    const { packageDir, rootDir } = await createProject({ platformPackage: true })

    expect(resolveInstalledCodexExecutable(pathToFileURL(join(rootDir, "server.mjs")).href)).toBe(join(packageDir, "bin", "codex.js"))
    expect(resolveCodexRuntimePackages({ arch: "x64", platform: "linux", rootDir })).toEqual([
      { name: "@openai/codex", resolveFrom: join(rootDir, "package.json") },
      { name: "@openai/codex-linux-x64", resolveFrom: join(packageDir, "package.json") },
    ])
  })

  it("leaves the host Codex executable as the fallback when the package is absent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-codex-runtime-absent-"))
    tempDirs.push(rootDir)
    await writeFile(join(rootDir, "package.json"), "{}\n")

    expect(resolveInstalledCodexExecutable(pathToFileURL(join(rootDir, "server.mjs")).href)).toBeUndefined()
    expect(resolveCodexRuntimePackages({ rootDir })).toEqual([])
  })

  it("keeps the host Codex command fallback on Windows", async () => {
    const { rootDir } = await createProject({ platformPackage: true })

    expect(resolveInstalledCodexExecutable(pathToFileURL(join(rootDir, "server.mjs")).href, "win32")).toBeUndefined()
  })

  it("fails when the installed Codex package lacks the selected native payload", async () => {
    const { rootDir } = await createProject()

    expect(() => resolveCodexRuntimePackages({ arch: "x64", platform: "linux", rootDir }))
      .toThrow("@openai/codex-linux-x64 optional dependency is missing")
  })

  it("fails explicitly for unsupported deployment targets", async () => {
    const { rootDir } = await createProject({ platformPackage: true })

    expect(() => resolveCodexRuntimePackages({ arch: "riscv64", platform: "linux", rootDir }))
      .toThrow("Cannot package @openai/codex for linux/riscv64")
  })
})
