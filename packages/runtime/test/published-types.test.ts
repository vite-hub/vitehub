import { execFile } from "node:child_process"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterAll, beforeAll, it } from "vitest"

import { syncPackedWorkspaceDependencies } from "../../internal/test-utils/published-types.js"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(packageRoot, "../..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")
const phaseTimeout = 15_000
const phaseEnvelopeTimeout = 20_000
const setupEnvelopeTimeout = 45_000
let consumerRoot: string | undefined

async function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd,
      killSignal: "SIGKILL",
      timeout: phaseTimeout,
    })
  }
  catch (error) {
    const output = error as Error & { stderr?: string, stdout?: string }
    throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
  }
}

beforeAll(async () => {
  consumerRoot = await mkdtemp(join(tmpdir(), "vitehub-runtime-types-"))
  await cp(fixtureRoot, consumerRoot, { recursive: true })
  await syncPackedWorkspaceDependencies(consumerRoot, workspaceRoot, ["@vite-hub/runtime"])
  const packResults = await Promise.allSettled([runProcess("npm", [
    "pack",
    "--pack-destination",
    consumerRoot,
    "--ignore-scripts",
    "--cache",
    join(consumerRoot, ".npm-cache"),
  ], packageRoot)])
  const failedPack = packResults.find(result => result.status === "rejected")
  if (failedPack) throw failedPack.reason
  await runProcess("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--cache",
    join(consumerRoot, ".npm-cache"),
  ], consumerRoot)
}, setupEnvelopeTimeout)

afterAll(async () => {
  if (consumerRoot) await rm(consumerRoot, { force: true, recursive: true })
})

it("publishes the ViteHub error contract", { timeout: phaseEnvelopeTimeout }, async () => {
  await runProcess(process.execPath, [tsc, "--noEmit", "-p", consumerRoot!], packageRoot)
})
