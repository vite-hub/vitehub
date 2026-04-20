import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")

beforeAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vitehub"), { force: true, recursive: true })
})

afterAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vitehub"), { force: true, recursive: true })
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
    const vercelServerContents = await readFile(vercelServer, "utf8")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(await readFile(cloudflareConfig, "utf8")).not.toContain("\"run_worker_first\"")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(existsSync(vercelConsumer)).toBe(true)
    expect(existsSync(vercelConsumerConfig)).toBe(true)
    expect(existsSync(vercelConsumerSource)).toBe(false)
    expect(vercelServerContents).toContain('createRequire as __createRequire')
    expect(vercelServerContents).not.toMatch(/from ["']@vercel\/queue["']/)
    expect(vercelServerContents).not.toMatch(/import\(["']@vercel\/queue["']\)/)
    expect(vercelConsumerContents).toContain('createRequire as __createRequire')
    expect(vercelConsumerContents).not.toContain('import queueRegistry from')
    expect(vercelConsumerContents).not.toContain('from "./')
    expect(vercelConsumerContents).not.toContain('from "../')
    expect(vercelConsumerContents).not.toMatch(/from ["']@vercel\/queue["']/)
    expect(vercelConsumerContents).not.toMatch(/import\(["']@vercel\/queue["']\)/)
    expect(vercelConsumerTrigger).toEqual({
      consumer: "api_Svitehub_Squeues_Svercel_Swelcome-email_Swelcome-email_Dfunc",
      topic: "topic--77656c636f6d652d656d61696c",
      type: "queue/v2beta",
    })
    expect(existsSync(vercelStatic)).toBe(false)
  }, 15_000)
})
