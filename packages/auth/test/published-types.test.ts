import { execFile } from "node:child_process"
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
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
const packedPackages = [
  "agent",
  "auth",
  "box",
  "devtools",
  "markdown-template",
  "rate-limit",
  "runtime",
  "source",
  "workspace",
] as const

async function runPnpm(args: string[], cwd: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath?.includes("pnpm")) {
    await execFileAsync(process.execPath, [npmExecPath, ...args], { cwd })
    return
  }
  await execFileAsync("corepack", ["pnpm", ...args], { cwd })
}

it("publishes the structured Auth error contract from installed packages", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-auth-types-"))

  try {
    await cp(fixtureRoot, root, { recursive: true })
    await Promise.all(packedPackages.map(name => (
      runPnpm(["pack", "--pack-destination", root], join(workspaceRoot, "packages", name))
    )))
    await runPnpm(["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], root)

    try {
      await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
    }
    catch (error) {
      const diagnostics = error as { stderr?: string, stdout?: string }
      throw new Error([diagnostics.stdout, diagnostics.stderr].filter(Boolean).join("\n"), { cause: error })
    }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

it("keeps Effect internals out of published Auth artifacts", async () => {
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
