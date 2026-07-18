import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(workspaceRoot, "node_modules/typescript/bin/tsc")

it("publishes the structured Authentication Required error contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-auth-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    await mkdir(join(root, "node_modules"), { recursive: true })
    await symlink(join(workspaceRoot, "node_modules", "@types"), join(root, "node_modules", "@types"), "dir")
    for (const name of ["agent", "auth", "runtime"]) {
      const source = join(workspaceRoot, "packages", name)
      const installed = join(root, "node_modules", "@vite-hub", name)
      await mkdir(installed, { recursive: true })
      await copyFile(join(source, "package.json"), join(installed, "package.json"))
      await cp(join(source, "dist"), join(installed, "dist"), { recursive: true })
      if (name === "agent") {
        await symlink(join(source, "node_modules"), join(installed, "node_modules"), "dir")
      }
    }

    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, 15_000)
