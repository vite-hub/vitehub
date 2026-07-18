import { execFile } from "node:child_process"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")

it("publishes the ViteHub error contract", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-runtime-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    const npmCache = join(root, ".npm-cache")
    await execFileAsync("npm", ["pack", "--pack-destination", root, "--ignore-scripts", "--cache", npmCache], {
      cwd: packageRoot,
    })
    await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--cache", npmCache], {
      cwd: root,
    })

    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
