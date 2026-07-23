import { execFile } from "node:child_process"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const fixtureRoot = join(packageRoot, "fixtures", "published-types")
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")

async function runPnpm(args: string[], cwd: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath?.includes("pnpm")) {
    await execFileAsync(process.execPath, [npmExecPath, ...args], { cwd })
    return
  }
  await execFileAsync("corepack", ["pnpm", ...args], { cwd })
}

it("publishes every documented Rate Limit entrypoint to a real consumer", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-types-"))
  try {
    await cp(fixtureRoot, root, { recursive: true })
    const version = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version
    const consumerManifestPath = join(root, "package.json")
    const consumerManifest = JSON.parse(await readFile(consumerManifestPath, "utf8"))
    consumerManifest.dependencies["@vite-hub/rate-limit"] = `file:./vite-hub-rate-limit-${version}.tgz`
    await writeFile(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`)
    await runPnpm(["pack", "--pack-destination", root], packageRoot)
    await runPnpm(["install", "--ignore-scripts", "--no-frozen-lockfile"], root)
    try {
      await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", root])
    }
    catch (error) {
      const result = error as Error & { stdout?: string, stderr?: string }
      throw new Error([result.message, result.stdout, result.stderr].filter(Boolean).join("\n"))
    }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
