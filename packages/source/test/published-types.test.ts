import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
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
const processTimeout = 15_000
const testTimeout = 45_000

it("publishes the Source error contract to installed consumers", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-source-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    const packDir = join(root, "packs")
    await mkdir(packDir)
    const specs = await packWorkspacePackages(packDir, ["@vite-hub/runtime", "@vite-hub/source"])
    await writeFile(join(root, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8")
    await run("vp", ["exec", "pnpm", "install", "--prefer-offline", "--ignore-scripts", "--strict-peer-dependencies"], root)

    await run(process.execPath, [tsc, "--noEmit", "-p", root], root)
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, testTimeout)

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

async function run(command: string, args: string[], cwd: string) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      killSignal: "SIGKILL",
      timeout: processTimeout,
    })
  }
  catch (error) {
    const output = error as Error & { stderr?: string, stdout?: string }
    throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
  }
}

async function packWorkspacePackages(packDir: string, packageNames: string[]) {
  const specs: Record<string, string> = {}
  for (const packageName of packageNames) {
    const packagePath = join(repositoryRoot, "packages", packageName.slice("@vite-hub/".length))
    const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as { version: string }
    await run("vp", ["exec", "pnpm", "--filter", packageName, "pack", "--pack-destination", packDir], repositoryRoot)
    specs[packageName] = `file:${join(packDir, `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`)}`
  }
  return specs
}

function workspaceConfig(specs: Record<string, string>) {
  return [
    "packages:",
    "  - .",
    "overrides:",
    ...Object.entries(specs).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`),
    "",
  ].join("\n")
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? await listFiles(path) : [path]
  }))).flat()
}
