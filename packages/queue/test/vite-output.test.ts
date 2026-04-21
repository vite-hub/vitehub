import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build, createNitro, prepare } from "nitro/builder"

import { generateProviderOutputs } from "../src/internal/vite-build.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const nitroBuildDir = join(playgroundDir, "node_modules", ".nitro-output-test")
const nitroOutputRoot = join(playgroundDir, ".queue-test-output")
const tempDirs: string[] = []

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  await mkdir(baseDir, { recursive: true })
  const rootDir = await mkdtemp(join(baseDir, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

beforeAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vitehub"), { force: true, recursive: true })
  await rm(nitroBuildDir, { force: true, recursive: true })
  await rm(nitroOutputRoot, { force: true, recursive: true })
})

afterAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vitehub"), { force: true, recursive: true })
  await rm(nitroBuildDir, { force: true, recursive: true })
  await rm(nitroOutputRoot, { force: true, recursive: true })
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function buildNitroPlayground(preset: string) {
  const outputDir = join(nitroOutputRoot, preset)
  const previousEnv = {
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
  }

  if (preset === "vercel") {
    process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN ?? "test-token"
    process.env.KV_REST_API_URL = process.env.KV_REST_API_URL ?? "https://example.com"
  }

  const nitro = await createNitro({
    buildDir: nitroBuildDir,
    output: {
      dir: outputDir,
    },
    preset,
    rootDir: playgroundDir,
  })

  try {
    await prepare(nitro)
    await build(nitro)
  }
  finally {
    await nitro.close()
    if (previousEnv.KV_REST_API_TOKEN === undefined) {
      delete process.env.KV_REST_API_TOKEN
    }
    else {
      process.env.KV_REST_API_TOKEN = previousEnv.KV_REST_API_TOKEN
    }
    if (previousEnv.KV_REST_API_URL === undefined) {
      delete process.env.KV_REST_API_URL
    }
    else {
      process.env.KV_REST_API_URL = previousEnv.KV_REST_API_URL
    }
  }

  return outputDir
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

describe("Vite provider outputs", () => {
  it("builds the playground and emits cloudflare and vercel outputs", async () => {
    await execFileAsync("pnpm", ["exec", "vite", "build"], {
      cwd: playgroundDir,
      env: process.env,
    })

    const cloudflareWorker = join(playgroundDir, "dist", "vite", "index.js")
    const cloudflareConfig = join(playgroundDir, "dist", "vite", "wrangler.json")
    const vercelConfig = join(playgroundDir, ".vercel", "output", "config.json")
    const vercelServer = join(playgroundDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const vercelConsumer = join(playgroundDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", "index.mjs")
    const vercelConsumerConfig = join(playgroundDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", ".vc-config.json")
    const vercelConsumerSource = join(playgroundDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", "index.source.mjs")
    const vercelStatic = join(playgroundDir, ".vercel", "output", "static")
    const vercelConsumerContents = await readFile(vercelConsumer, "utf8")
    const vercelServerContents = await readFile(vercelServer, "utf8")
    const vercelConsumerTrigger = JSON.parse(await readFile(vercelConsumerConfig, "utf8")).experimentalTriggers?.[0]

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(await readFile(cloudflareConfig, "utf8")).not.toContain("\"run_worker_first\"")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(existsSync(vercelConsumer)).toBe(true)
    expect(existsSync(vercelConsumerConfig)).toBe(true)
    expect(existsSync(vercelConsumerSource)).toBe(false)
    expect(vercelConsumerContents).toContain("waitUntil")
    expect(vercelConsumerContents).not.toContain("runWithQueueRuntimeEvent({ req, res },")
    expect(vercelConsumerContents).toContain("queue-e2e:")
    expect(vercelServerContents).toContain("queue-e2e:")
    expect(vercelConsumerTrigger).toEqual({
      consumer: "api_Svitehub_Squeues_Svercel_Swelcome-email_Swelcome-email_Dfunc",
      topic: "topic--77656c636f6d652d656d61696c",
      type: "queue/v2beta",
    })
    expect(existsSync(vercelStatic)).toBe(false)
  }, 15_000)

  it("builds Nitro provider output for the Vite playground without unresolved Nitro internals", async () => {
    const cloudflareOutput = await buildNitroPlayground("cloudflare_module")
    await assertNoNitroInternalVirtualImports(cloudflareOutput)

    await rm(nitroBuildDir, { force: true, recursive: true })

    const vercelOutput = await buildNitroPlayground("vercel")
    await assertNoNitroInternalVirtualImports(vercelOutput)
  }, 45_000)

  it("skips Vercel queue functions when queue support is disabled", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-disabled-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      queue: false,
      rootDir,
    })

    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"))).toBe(true)
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel"))).toBe(false)
  })

  it("copies Vercel static output from Vite's default dist directory", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-default-dist-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      queue: {},
      rootDir,
    })

    expect(await readFile(join(rootDir, ".vercel", "output", "static", "index.html"), "utf8")).toContain("<title>vitehub</title>")
  })

  it("throws when queue names collide after Vercel sanitization", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-collision-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "foo.bar.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "src", "foo+bar.queue.ts"), "export default null\n", "utf8")

    await expect(generateProviderOutputs({
      clientOutDir: "dist/client",
      queue: {},
      rootDir,
    })).rejects.toThrow(/collide after Vercel output sanitization/)
  })
})
