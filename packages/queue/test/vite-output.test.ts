import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { generateProviderOutputs } from "../src/internal/vite-build.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
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
})

afterAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vitehub"), { force: true, recursive: true })
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite provider outputs", () => {
  it("builds the playground and emits cloudflare and vercel outputs", async () => {
    await execFileAsync("pnpm", ["--filter", "@vitehub/queue", "build"], {
      cwd: resolve(playgroundDir, "../.."),
      env: process.env,
    })

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
    expect(vercelConsumerTrigger).toEqual({
      consumer: "api_Svitehub_Squeues_Svercel_Swelcome-email_Swelcome-email_Dfunc",
      topic: "topic--77656c636f6d652d656d61696c",
      type: "queue/v2beta",
    })
    expect(existsSync(vercelStatic)).toBe(false)
  }, 15_000)

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
