import { execFile } from "node:child_process"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterAll, beforeAll, it } from "vitest"

import { packedWorkspacePackages, syncPackedWorkspaceDependencies } from "../../internal/test-utils/published-types.js"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(workspaceRoot, "node_modules/typescript/bin/tsc")
const childProcessTimeout = 15_000
// A fresh consumer resolves and links hundreds of packages, even with a warm store.
const installTimeout = 120_000
const packedPackages = await packedWorkspacePackages(workspaceRoot, [
  "agent",
  "auth",
  "sandbox",
  "env",
  "forge",
  "gateways",
  "markdown-template",
  "rate-limit",
  "runtime",
  "source",
  "workspace",
])
let consumerRoot: string | undefined

async function runPnpm(args: string[], cwd: string, timeout = childProcessTimeout): Promise<void> {
  try {
    const npmExecPath = process.env.npm_execpath
    if (npmExecPath?.includes("pnpm")) {
      await execFileAsync(npmExecPath, args, {
        cwd,
        killSignal: "SIGKILL",
        timeout,
      })
      return
    }
    await execFileAsync("corepack", ["pnpm", ...args], {
      cwd,
      killSignal: "SIGKILL",
      timeout,
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
  await runPnpm([
    "install",
    "--prefer-offline",
    "--ignore-scripts",
    "--no-frozen-lockfile",
    "--config.blockExoticSubdeps=false",
  ], consumerRoot, installTimeout)
}, installTimeout + 2 * childProcessTimeout)

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
