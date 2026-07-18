import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageRoot, "../..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(repositoryRoot, "node_modules/typescript/bin/tsc")

it("publishes the Source error contract to installed consumers", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-source-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    await installBuiltPackage(root, "source")
    await installBuiltPackage(root, "runtime")
    const sdkRoot = await realpath(join(packageRoot, "node_modules", "@modelcontextprotocol", "sdk"))
    const sdkInstallRoot = join(root, "node_modules", "@modelcontextprotocol", "sdk")
    await mkdir(dirname(sdkInstallRoot), { recursive: true })
    await symlink(sdkRoot, sdkInstallRoot, "dir")

    try {
      await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
    }
    catch (error) {
      const output = error as { stderr?: string, stdout?: string }
      throw new Error([output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
    }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

it("keeps Effect out of Source declarations and runtime bundles", async () => {
  const files = await listFiles(join(packageRoot, "dist"))
  const declarations = files.filter(file => file.endsWith(".d.ts"))
  const runtimeFiles = files.filter(file => extname(file) === ".js")
  const effectReference = /(?:from\s+|import\s*\()(["'])effect(?:\/[^"']*)?\1/

  expect(declarations.length).toBeGreaterThan(0)
  expect(runtimeFiles.length).toBeGreaterThan(0)

  for (const file of [...declarations, ...runtimeFiles]) {
    expect(await readFile(file, "utf8"), file).not.toMatch(effectReference)
  }

  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }
  expect(pkg.dependencies?.effect).toBeUndefined()
})

async function installBuiltPackage(root: string, name: "runtime" | "source") {
  const sourceRoot = resolve(repositoryRoot, "packages", name)
  const installedRoot = join(root, "node_modules", "@vite-hub", name)
  await mkdir(installedRoot, { recursive: true })
  await copyFile(join(sourceRoot, "package.json"), join(installedRoot, "package.json"))
  await cp(join(sourceRoot, "dist"), join(installedRoot, "dist"), { recursive: true })
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? await listFiles(path) : [path]
  }))).flat()
}
