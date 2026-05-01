import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build, createNitro, prepare } from "nitro/builder"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/nitro")
const repoRoot = resolve(playgroundDir, "../..")
const testBuildDir = join(playgroundDir, "node_modules", ".workspace-nitro-output-test")
const testOutputRoot = join(playgroundDir, ".workspace-test-output")
const playgroundNitroPackages = ["blob", "kv", "queue", "sandbox", "workflow"] as const

async function cleanupPlayground() {
  await rm(testBuildDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
  await rm(testOutputRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
}

async function buildPlayground(preset: string) {
  const outputDir = join(testOutputRoot, preset)
  const nitro = await createNitro({
    buildDir: testBuildDir,
    output: { dir: outputDir },
    preset,
    rootDir: playgroundDir,
  })
  await prepare(nitro)
  await build(nitro)
  const output = {
    buildDir: nitro.options.buildDir,
    outputDir,
  }
  await nitro.close()
  return output
}

async function assertNoNitroInternalVirtualImports(outputDir: string) {
  const files = [
    join(outputDir, "server", "_chunks", "runtime.mjs"),
    join(outputDir, "functions", "__server.func", "_chunks", "runtime.mjs"),
  ]

  for (const file of files) {
    if (!existsSync(file)) continue
    await expect(readFile(file, "utf8")).resolves.not.toContain("#nitro-internal-virtual/")
  }
}

beforeAll(async () => {
  await cleanupPlayground()
  for (const name of playgroundNitroPackages) {
    await execFileAsync("pnpm", ["--filter", `@vitehub/${name}`, "build"], {
      cwd: repoRoot,
      env: process.env,
    })
  }
}, 120_000)

afterAll(async () => {
  await cleanupPlayground()
})

describe("Nitro workspace outputs", () => {
  it("builds the Nitro playground for cloudflare_module and vercel", async () => {
    const cloudflareBuild = await buildPlayground("cloudflare_module")
    const registryFile = join(playgroundDir, ".vitehub/nitro-runtime/workspace/registry.mjs")
    const registryContents = await readFile(registryFile, "utf8")
    const cloudflareNitroJson = JSON.parse(await readFile(join(cloudflareBuild.outputDir, "nitro.json"), "utf8"))

    expect(registryContents).toContain('"docs": async () => import(')
    expect(existsSync(join(cloudflareBuild.outputDir, cloudflareNitroJson.serverEntry))).toBe(true)
    const cloudflareWrangler = JSON.parse(await readFile(join(cloudflareBuild.outputDir, "server", "wrangler.json"), "utf8"))
    expect(cloudflareWrangler.artifacts).toEqual([
      expect.objectContaining({ binding: "WORKSPACE_ARTIFACTS", namespace: "vitehub" }),
    ])
    await assertNoNitroInternalVirtualImports(cloudflareBuild.outputDir)

    await cleanupPlayground()

    const vercelBuild = await buildPlayground("vercel")
    const vercelNitroJson = JSON.parse(await readFile(join(vercelBuild.outputDir, "nitro.json"), "utf8"))
    expect(existsSync(join(vercelBuild.outputDir, vercelNitroJson.serverEntry))).toBe(true)
    await assertNoNitroInternalVirtualImports(vercelBuild.outputDir)
  }, 45_000)
})
