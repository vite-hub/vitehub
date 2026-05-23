import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build, createNitro, prepare } from "nitro/builder"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/nitro")
const repoRoot = resolve(playgroundDir, "../..")
const testBuildDir = join(playgroundDir, "node_modules", ".workspace-nitro-output-test")
const testOutputRoot = join(playgroundDir, ".workspace-test-output")
const playgroundNitroPackages = ["blob", "chat", "env", "kv", "queue", "sandbox", "workflow"] as const

async function cleanupPlayground() {
  await rm(testBuildDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
  await rm(testOutputRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
}

async function buildPlayground(preset: string) {
  const outputDir = join(testOutputRoot, preset)
  const previousVercelBlobToken = process.env.BLOB_READ_WRITE_TOKEN
  if (preset.includes("vercel")) process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_test_token"
  const nitro = await createNitro({
    buildDir: testBuildDir,
    dev: false,
    output: { dir: outputDir },
    preset,
    rootDir: playgroundDir,
    runtimeConfig: {},
  })
  try {
    await prepare(nitro)
    await build(nitro)
  }
  finally {
    if (preset.includes("vercel")) {
      if (previousVercelBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
      else process.env.BLOB_READ_WRITE_TOKEN = previousVercelBlobToken
    }
  }
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

async function readGeneratedJavaScript(outputDir: string): Promise<string> {
  const chunks: string[] = []
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) chunks.push(await readFile(path, "utf8"))
    }
  }
  await walk(outputDir)
  return chunks.join("\n")
}

beforeAll(async () => {
  await cleanupPlayground()
  for (const name of playgroundNitroPackages) {
    await execFileAsync("pnpm", ["--filter", `@vitehub/${name}`, "build"], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 1024 * 1024 * 16,
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
    const configTypes = await readFile(join(cloudflareBuild.buildDir, "types", "vitehub-workspace-nitro.d.ts"), "utf8")
    const cloudflareNitroJson = JSON.parse(await readFile(join(cloudflareBuild.outputDir, "nitro.json"), "utf8"))

    expect(registryContents).toContain('"docs": async () => {')
    expect(registryContents).toContain("sourceRootDir")
    expect(configTypes).toContain("workspace?: false | WorkspaceModuleOptions")
    expect(configTypes).toContain("interface ViteHubWorkspaceNameMap")
    expect(configTypes).toContain("interface ViteHubWorkspaceAssetMap")
    expect(configTypes).toContain('"docs": true')
    expect(existsSync(join(cloudflareBuild.outputDir, cloudflareNitroJson.serverEntry))).toBe(true)
    const cloudflareWrangler = JSON.parse(await readFile(join(cloudflareBuild.outputDir, "server", "wrangler.json"), "utf8"))
    expect(cloudflareWrangler.artifacts).toBeUndefined()
    await assertNoNitroInternalVirtualImports(cloudflareBuild.outputDir)
    const cloudflareOutput = await readGeneratedJavaScript(cloudflareBuild.outputDir)
    expect(cloudflareOutput).not.toMatch(/(?:from|import\(|require\()\s*["']@vercel\/blob["']/)
    expect(cloudflareOutput).not.toContain("node-gyp-build")
    expect(cloudflareOutput).not.toContain("node-liblzma")
    expect(cloudflareOutput).not.toContain("zstd.node")
    expect(cloudflareOutput).not.toContain("js-exec-worker")
    expect(cloudflareOutput).not.toContain("resolveShellDependency")
    expect(cloudflareOutput).not.toContain("resolveIsomorphicGitEsmEntry")
    expect(cloudflareOutput).not.toContain("createCloudflareArtifactsWorkspaceStore")

    await cleanupPlayground()

    const vercelBuild = await buildPlayground("vercel")
    const vercelNitroJson = JSON.parse(await readFile(join(vercelBuild.outputDir, "nitro.json"), "utf8"))
    expect(existsSync(join(vercelBuild.outputDir, vercelNitroJson.serverEntry))).toBe(true)
    await assertNoNitroInternalVirtualImports(vercelBuild.outputDir)
    const vercelOutput = await readGeneratedJavaScript(vercelBuild.outputDir)
    expect(vercelOutput).not.toContain("createCloudflareArtifactsWorkspaceStore")
    expect(vercelOutput).not.toContain("__vitehubVercelBlob")
    expect(vercelOutput).toContain("createVercelBlobWorkspaceStore")
    expect(vercelOutput).not.toContain("Cloudflare Artifacts binding")
    expect(vercelOutput).not.toContain("isomorphic-git")
  }, 90_000)
})
