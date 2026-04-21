import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build, createNitro, prepare } from "nitro/builder"

import { writeNitroVercelQueueOutputs } from "../src/internal/nitro-build.ts"

const playgroundDir = resolve(import.meta.dirname, "../../../playground/nitro")
const testBuildDir = join(playgroundDir, "node_modules", ".nitro-output-test")
const testOutputRoot = join(playgroundDir, ".queue-test-output")
const tempDirs: string[] = []

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  await mkdir(baseDir, { recursive: true })
  const rootDir = await mkdtemp(join(baseDir, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

async function buildPlayground(preset: string) {
  const outputDir = join(testOutputRoot, preset)
  const nitro = await createNitro({
    buildDir: testBuildDir,
    output: {
      dir: outputDir,
    },
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

async function cleanupPlayground() {
  await rm(testBuildDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
  await rm(testOutputRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
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
})

afterAll(async () => {
  await cleanupPlayground()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Nitro provider outputs", () => {
  it("builds the Nitro playground for cloudflare_module and vercel", async () => {
    const cloudflareBuild = await buildPlayground("cloudflare_module")

    const registryFile = join(cloudflareBuild.buildDir, ".vitehub", "queue", "nitro-registry.mjs")
    const cloudflareNitroJson = JSON.parse(await readFile(join(cloudflareBuild.outputDir, "nitro.json"), "utf8"))
    const cloudflareServerEntry = join(cloudflareBuild.outputDir, cloudflareNitroJson.serverEntry)
    const registryContents = await readFile(registryFile, "utf8")

    expect(existsSync(cloudflareServerEntry)).toBe(true)
    expect(registryContents).toContain('"welcome": async () => import(')
    expect(registryContents).toContain("server/queues/welcome.ts")
    await assertNoNitroInternalVirtualImports(cloudflareBuild.outputDir)

    await cleanupPlayground()

    const vercelBuild = await buildPlayground("vercel")
    const vercelNitroJson = JSON.parse(await readFile(join(vercelBuild.outputDir, "nitro.json"), "utf8"))
    const vercelFunctionsDir = join(vercelBuild.outputDir, "functions")
    const vercelServer = join(vercelBuild.outputDir, vercelNitroJson.serverEntry)

    const vercelConsumer = join(vercelFunctionsDir, "api", "vitehub", "queues", "vercel", "welcome", "welcome.func", "index.mjs")
    const vercelConsumerConfig = join(vercelFunctionsDir, "api", "vitehub", "queues", "vercel", "welcome", "welcome.func", ".vc-config.json")
    const vercelConsumerContents = await readFile(vercelConsumer, "utf8")
    const vercelConsumerTrigger = JSON.parse(await readFile(vercelConsumerConfig, "utf8")).experimentalTriggers?.[0]

    expect(existsSync(vercelServer)).toBe(true)
    expect(existsSync(vercelConsumer)).toBe(true)
    expect(vercelConsumerContents).toContain("waitUntil")
    expect(vercelConsumerContents).not.toContain("runWithQueueRuntimeEvent({ req, res },")
    await assertNoNitroInternalVirtualImports(vercelBuild.outputDir)
    expect(vercelConsumerTrigger).toEqual({
      consumer: "api_Svitehub_Squeues_Svercel_Swelcome_Swelcome_Dfunc",
      topic: "topic--77656c636f6d65",
      type: "queue/v2beta",
    })
  }, 30_000)

  it("throws when Nitro queue names collide after Vercel sanitization", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-nitro-collision-")
    const outputDir = join(rootDir, ".output")
    const registryFile = join(rootDir, ".vitehub", "queue", "nitro-registry.mjs")
    const serverDir = join(rootDir, "server")

    await mkdir(join(serverDir, "queues"), { recursive: true })
    await mkdir(join(rootDir, ".vitehub", "queue"), { recursive: true })
    await writeFile(join(serverDir, "queues", "foo.bar.ts"), "export default null\n", "utf8")
    await writeFile(join(serverDir, "queues", "foo+bar.ts"), "export default null\n", "utf8")
    await writeFile(registryFile, "export default {}\n", "utf8")

    await expect(writeNitroVercelQueueOutputs({
      outputDir,
      queue: {},
      registryFile,
      scanDirs: [serverDir],
    })).rejects.toThrow(/collide after Vercel output sanitization/)
  })
})
