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
const fixtureRoot = join(packageRoot, "fixtures", "published-chat-adapter-types")
const tsc = resolve(workspaceRoot, "node_modules/typescript/bin/tsc")
const childProcessTimeout = 20_000
const packedPackages = [
  "agent",
  "box",
  "history",
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
  consumerRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-chat-types-"))
  await cp(fixtureRoot, consumerRoot, { recursive: true })
  await syncPackedWorkspaceDependencies(
    consumerRoot,
    workspaceRoot,
    packedPackages.map(name => `@vite-hub/${name}`),
  )
  const packs = await Promise.allSettled(packedPackages.map(name =>
    runPnpm(["pack", "--pack-destination", consumerRoot!], join(workspaceRoot, "packages", name))))
  const failedPack = packs.find(result => result.status === "rejected")
  if (failedPack) throw failedPack.reason
  await runPnpm([
    "install",
    "--prefer-offline",
    "--ignore-scripts",
    "--no-frozen-lockfile",
    "--strict-peer-dependencies",
  ], consumerRoot)
}, 60_000)

afterAll(async () => {
  if (consumerRoot) await rm(consumerRoot, { force: true, recursive: true })
})

it("accepts the pinned Chat SDK adapter from the published package", { timeout: 25_000 }, async () => {
  try {
    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", consumerRoot!], {
      cwd: packageRoot,
      killSignal: "SIGKILL",
      timeout: childProcessTimeout,
    })
  }
  catch (error) {
    const output = error as Error & { stderr?: string, stdout?: string }
    throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
  }
})
