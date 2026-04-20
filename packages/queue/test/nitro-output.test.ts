import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build, createNitro, prepare } from "nitro/builder"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/nitro")
const workspaceRoot = resolve(playgroundDir, "../..")
const testBuildDir = join(playgroundDir, "node_modules", ".nitro-output-test")
const testOutputRoot = join(playgroundDir, ".queue-test-output")

async function buildQueuePackage() {
  await execFileAsync("pnpm", ["--filter", "@vitehub/queue", "build"], {
    cwd: workspaceRoot,
    env: process.env,
  })
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

beforeAll(async () => {
  await cleanupPlayground()
})

afterAll(async () => {
  await cleanupPlayground()
})

describe("Nitro provider outputs", () => {
  it("builds the Nitro playground for cloudflare_module and vercel", async () => {
    await buildQueuePackage()

    const cloudflareBuild = await buildPlayground("cloudflare_module")

    const registryFile = join(cloudflareBuild.buildDir, ".vitehub", "queue", "nitro-registry.mjs")
    const cloudflareNitroJson = JSON.parse(await readFile(join(cloudflareBuild.outputDir, "nitro.json"), "utf8"))
    const cloudflareServerEntry = join(cloudflareBuild.outputDir, cloudflareNitroJson.serverEntry)
    const registryContents = await readFile(registryFile, "utf8")

    expect(existsSync(cloudflareServerEntry)).toBe(true)
    expect(registryContents).toContain('"welcome": async () => import(')
    expect(registryContents).toContain("server/queues/welcome.ts")

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
    expect(vercelConsumerContents).not.toContain('import queueRegistry from')
    expect(vercelConsumerContents).not.toContain('from "./')
    expect(vercelConsumerContents).not.toContain('from "../')
    expect(vercelConsumerTrigger).toEqual({
      consumer: "api_Svitehub_Squeues_Svercel_Swelcome_Swelcome_Dfunc",
      topic: "topic--77656c636f6d65",
      type: "queue/v2beta",
    })
  }, 30_000)
})
