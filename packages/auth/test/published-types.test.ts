import { execFile } from "node:child_process"
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterAll, beforeAll, expect, it } from "vitest"

import { syncPackedWorkspaceDependencies } from "../../internal/test-utils/published-types.js"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(workspaceRoot, "node_modules/typescript/bin/tsc")
const childProcessTimeout = 15_000
const packedPackages = [
  "agent",
  "auth",
  "box",
  "env",
  "markdown-template",
  "rate-limit",
  "runtime",
  "source",
  "workspace",
] as const
let consumerRoot: string | undefined

async function runPnpm(args: string[], cwd: string): Promise<void> {
  try {
    const npmExecPath = process.env.npm_execpath
    if (npmExecPath?.includes("pnpm")) {
      await execFileAsync(process.execPath, [npmExecPath, ...args], {
        cwd,
        killSignal: "SIGKILL",
        timeout: childProcessTimeout,
      })
      return
    }
    await execFileAsync("corepack", ["pnpm", ...args], {
      cwd,
      killSignal: "SIGKILL",
      timeout: childProcessTimeout,
    })
  }
  catch (error) {
    const output = error as Error & { stderr?: string, stdout?: string }
    throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
  }
}

beforeAll(async () => {
  consumerRoot = await mkdtemp(join(tmpdir(), "vitehub-auth-types-"))
  await cp(fixtureRoot, consumerRoot, { recursive: true })
  await syncPackedWorkspaceDependencies(
    consumerRoot,
    workspaceRoot,
    packedPackages.map(name => `@vite-hub/${name}`),
  )
  const packResults = await Promise.allSettled(packedPackages.map(name => (
    runPnpm(["pack", "--pack-destination", consumerRoot!], join(workspaceRoot, "packages", name))
  )))
  const failedPack = packResults.find(result => result.status === "rejected")
  if (failedPack) throw failedPack.reason
  await runPnpm(["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"], consumerRoot)
}, 45_000)

afterAll(async () => {
  if (consumerRoot) await rm(consumerRoot, { force: true, recursive: true })
})

it("uses the shared ViteHubError contract from installed packages", { timeout: 20_000 }, async () => {
  const root = consumerRoot!
  try {
    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root], {
      killSignal: "SIGKILL",
      timeout: childProcessTimeout,
    })
  }
  catch (error) {
    const diagnostics = error as Error & { stderr?: string, stdout?: string }
    throw new Error([diagnostics.message, diagnostics.stdout, diagnostics.stderr].filter(Boolean).join("\n"), { cause: error })
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
