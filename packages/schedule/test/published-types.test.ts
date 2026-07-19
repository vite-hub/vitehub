import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const runtimePackageRoot = resolve(packageRoot, "../runtime")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")

interface PackageManifest {
  readonly exports: Record<string, string>
  readonly types: string
}

async function expectPublicDeclarationsToExcludeEffect(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageManifest
  const declarations = new Set([
    manifest.types,
    ...Object.values(manifest.exports)
      .filter(path => path.endsWith(".js"))
      .map(path => path.replace(/\.js$/, ".d.ts")),
  ])

  for (const declaration of declarations) {
    const source = await readFile(join(packageRoot, declaration), "utf8")
    expect(source, declaration).not.toMatch(/(?:from|import\()\s*["']effect(?:\/[^"']*)?["']/)
  }
}

it("publishes virtual Schedule registry declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    const installedPackageRoot = join(root, "node_modules", "@vite-hub", "schedule")
    const installedRuntimePackageRoot = join(root, "node_modules", "@vite-hub", "runtime")
    await mkdir(installedPackageRoot, { recursive: true })
    await mkdir(installedRuntimePackageRoot, { recursive: true })
    await copyFile(join(packageRoot, "package.json"), join(installedPackageRoot, "package.json"))
    await copyFile(join(runtimePackageRoot, "package.json"), join(installedRuntimePackageRoot, "package.json"))
    await cp(join(packageRoot, "dist"), join(installedPackageRoot, "dist"), { recursive: true })
    await cp(join(runtimePackageRoot, "dist"), join(installedRuntimePackageRoot, "dist"), { recursive: true })

    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
    await expectPublicDeclarationsToExcludeEffect()
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
