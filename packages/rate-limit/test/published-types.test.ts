import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")

it("publishes every documented Rate Limit entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-types-"))
  try {
    await cp(fixtureRoot, root, { recursive: true })
    const installedPackageRoot = join(root, "node_modules", "@vite-hub", "rate-limit")
    await mkdir(installedPackageRoot, { recursive: true })
    await copyFile(join(packageRoot, "package.json"), join(installedPackageRoot, "package.json"))
    await cp(join(packageRoot, "dist"), join(installedPackageRoot, "dist"), { recursive: true })
    try {
      await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
    }
    catch (error) {
      const result = error as Error & { stdout?: string, stderr?: string }
      throw new Error([result.message, result.stdout, result.stderr].filter(Boolean).join("\n"))
    }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
