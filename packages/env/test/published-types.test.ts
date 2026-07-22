import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

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

    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

it("keeps Effect internals out of published Env artifacts", async () => {
  const dist = resolve(packageRoot, "dist")
  const files = (await readdir(dist, { recursive: true }))
    .filter(path => /\.(?:[cm]?js|d\.ts)$/.test(path))
  const output = (await Promise.all(files.map(path => readFile(join(dist, path), "utf8")))).join("\n")
  const manifestText = await readFile(join(packageRoot, "package.json"), "utf8")
  const manifest = JSON.parse(manifestText) as Record<string, Record<string, string> | undefined>

  expect(output).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']effect(?:\/[^"']*)?["']/)
  expect(output).not.toContain("FiberFailure")
  expect(manifestText).not.toMatch(/["']effect(?:\/[^"']*)?["']/)
  expect(manifest.dependencies?.effect).toBeUndefined()
  expect(manifest.devDependencies?.effect).toBeUndefined()
  expect(manifest.optionalDependencies?.effect).toBeUndefined()
  expect(manifest.peerDependencies?.effect).toBeUndefined()
})
