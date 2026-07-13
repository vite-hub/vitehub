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

it("publishes virtual Schedule registry declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    const installedPackageRoot = join(root, "node_modules", "@vite-hub", "schedule")
    await mkdir(installedPackageRoot, { recursive: true })
    await copyFile(join(packageRoot, "package.json"), join(installedPackageRoot, "package.json"))
    await cp(join(packageRoot, "dist"), join(installedPackageRoot, "dist"), { recursive: true })

    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
