import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"
import { createDefaultCloudflareOutputRoot } from "@vitehub/internal/build/deployment-output"

import { generateProviderOutputs, validateProviderCron } from "../src/internal/provider-output.ts"

const tempDirs: string[] = []

async function createTempProject(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src"), { recursive: true })
  await mkdir(join(rootDir, "dist", "client"), { recursive: true })
  await writeFile(join(rootDir, "src", "cleanup.schedule.ts"), [
    "export default { cron: '0 0 * * *', handler: () => 'ok' }",
    "",
  ].join("\n"), "utf8")
  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("schedule provider output", () => {
  it("emits Cloudflare and Vercel schedule provider wake output", async () => {
    const rootDir = await createTempProject("vitehub-schedule-output-")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareRoot = createDefaultCloudflareOutputRoot(rootDir)
    const cloudflareWorker = join(cloudflareRoot, "index.js")
    const cloudflareConfig = join(cloudflareRoot, "wrangler.json")
    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelFunction = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(JSON.parse(await readFile(cloudflareConfig, "utf8")).triggers.crons).toEqual(["0 0 * * *"])
    expect(JSON.parse(await readFile(vercelConfig, "utf8")).crons).toEqual([{
      path: "/api/vitehub/schedules/vercel/cleanup",
      schedule: "0 0 * * *",
    }])
    expect(await readFile(vercelFunction, "utf8")).toContain("executeStaticSchedule")
  })

  it("reports provider cron syntax limitations before output generation", () => {
    expect(() => validateProviderCron("0 0 1 1 * 2026", "cleanup")).toThrow(/provider wake output only supports five-field UTC cron syntax/)
  })
})
