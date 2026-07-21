import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = resolve(packageRoot, "../runtime")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")

it("publishes Workspace types through the package contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    for (const [name, source] of [["workspace", packageRoot], ["runtime", runtimeRoot]] as const) {
      const installedPackageRoot = join(root, "node_modules", "@vite-hub", name)
      await mkdir(installedPackageRoot, { recursive: true })
      await copyFile(join(source, "package.json"), join(installedPackageRoot, "package.json"))
      await cp(join(source, "dist"), join(installedPackageRoot, "dist"), { recursive: true })
    }
    await symlink(resolve(packageRoot, "node_modules/vue"), join(root, "node_modules/vue"), "junction")

    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
