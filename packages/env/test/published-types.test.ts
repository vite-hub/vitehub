import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const runtimeRoot = resolve(packageRoot, "../runtime")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(workspaceRoot, "node_modules/typescript/bin/tsc")

it("publishes Env error codes for the shared ViteHubError contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-env-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    for (const [name, sourceRoot] of [["env", packageRoot], ["runtime", runtimeRoot]] as const) {
      const installedPackageRoot = join(root, "node_modules", "@vite-hub", name)
      await mkdir(installedPackageRoot, { recursive: true })
      await copyFile(join(sourceRoot, "package.json"), join(installedPackageRoot, "package.json"))
      await cp(join(sourceRoot, "dist"), join(installedPackageRoot, "dist"), { recursive: true })
    }

    for (const dependency of ["nostics", "standard-context"]) {
      await cp(join(runtimeRoot, "node_modules", dependency), join(root, "node_modules", dependency), { dereference: true, recursive: true })
    }

    await writeFile(join(root, "tsconfig.cli.json"), JSON.stringify({
      compilerOptions: { types: ["node"], typeRoots: [join(workspaceRoot, "node_modules/@types")] },
      extends: "./tsconfig.json",
      files: ["cli-consumer.ts"],
    }))
    await execFileAsync(process.execPath, [tsc, "--build", root, join(root, "tsconfig.cli.json")])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
