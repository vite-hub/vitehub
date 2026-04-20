import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../playground/vite")

beforeAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
})

afterAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
})

describe("Vite provider outputs", () => {
  it("builds the playground and emits cloudflare and vercel outputs", async () => {
    await execFileAsync("pnpm", ["--filter", "@vitehub/queue", "build"], {
      cwd: resolve(playgroundDir, "../../../.."),
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
    const vercelStatic = join(playgroundDir, ".vercel", "output", "static")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(await readFile(cloudflareConfig, "utf8")).not.toContain("\"run_worker_first\"")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(existsSync(vercelConsumer)).toBe(true)
    expect(existsSync(vercelStatic)).toBe(false)
  }, 15_000)
})
