import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(workspaceRoot, "node_modules/typescript/bin/tsc")

it("publishes Queue error types for the shared ViteHubError contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-queue-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    const packDir = join(root, "packs")
    await mkdir(packDir)
    const specs = await packWorkspacePackages(packDir, ["@vite-hub/runtime", "@vite-hub/queue"])
    await writeFile(join(root, "pnpm-workspace.yaml"), workspaceConfig(specs), "utf8")
    await run("vp", ["exec", "pnpm", "install", "--prefer-offline", "--ignore-scripts", "--strict-peer-dependencies"], root)

    await run(process.execPath, [tsc, "--noEmit", "-p", root], root)
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, 15_000)

async function run(command: string, args: string[], cwd: string) {
  try {
    return await execFileAsync(command, args, { cwd })
  }
  catch (error) {
    const output = error as Error & { stderr?: string, stdout?: string }
    throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
  }
}

async function packWorkspacePackages(packDir: string, packageNames: string[]) {
  const specs: Record<string, string> = {}
  for (const packageName of packageNames) {
    const packagePath = join(workspaceRoot, "packages", packageName.slice("@vite-hub/".length))
    const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as { version: string }
    await run("vp", ["exec", "pnpm", "--filter", packageName, "pack", "--pack-destination", packDir], workspaceRoot)
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

it("keeps Effect internals out of published Queue artifacts", async () => {
  const dist = resolve(packageRoot, "dist")
  const files = (await readdir(dist, { recursive: true }))
    .filter(path => /\.(?:[cm]?js|d\.ts)$/.test(path))
  const output = (await Promise.all(files.map(path => readFile(join(dist, path), "utf8")))).join("\n")
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>

  expect(output).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']effect(?:\/[^"']*)?["']/)
  expect(output).not.toContain("FiberFailure")
  expect(manifest.dependencies?.effect).toBeUndefined()
  expect(manifest.devDependencies?.effect).toBeUndefined()
  expect(manifest.optionalDependencies?.effect).toBeUndefined()
  expect(manifest.peerDependencies?.effect).toBeUndefined()
})
