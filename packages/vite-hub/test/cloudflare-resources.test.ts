import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { findMissingCloudflareResources } from "../src/cloudflare-resources.ts"
import { vitehub } from "../src/index.ts"

import type { ViteHubResourceSummary } from "@vite-hub/internal/inspect"

describe("findMissingCloudflareResources", () => {
  const resources: ViteHubResourceSummary[] = [
    { binding: "QUEUE_WELCOME", definition: "welcome", host: "cloudflare", kind: "cloudflare-queue", name: "app-welcome", owner: "queue" },
    { binding: "WORKFLOW_ONBOARD", definition: "onboard", host: "cloudflare", kind: "cloudflare-workflow", name: "onboard", owner: "workflow" },
    { binding: "SANDBOX", definition: "default", host: "cloudflare", kind: "cloudflare-durable-object", name: "Sandbox", owner: "sandbox" },
    { binding: "DB", definition: "default", host: "cloudflare", kind: "cloudflare-d1", owner: "database" },
    { definition: "daily", host: "cloudflare", kind: "cloudflare-cron", name: "0 9 * * *", owner: "schedule" },
    { definition: "default", host: "cloudflare", kind: "cloudflare-container", name: "Sandbox", owner: "sandbox" },
    { definition: "default", host: "vercel", kind: "vercel-blob-store", owner: "blob" },
  ]

  it("finds nothing when the config has every resource", () => {
    expect(findMissingCloudflareResources({
      d1_databases: [{ binding: "DB", database_id: "id" }],
      durable_objects: { bindings: [{ class_name: "Sandbox", name: "SANDBOX" }] },
      queues: { consumers: [{ queue: "app-welcome" }], producers: [{ binding: "QUEUE_WELCOME", queue: "app-welcome" }] },
      triggers: { crons: ["0 9 * * *"] },
      workflows: [{ binding: "WORKFLOW_ONBOARD", class_name: "Onboard", name: "onboard" }],
    }, resources)).toEqual([])
  })

  it("finds dropped bindings, renamed resources, and dropped crons", () => {
    const missing = findMissingCloudflareResources({
      d1_databases: [{ binding: "DB", database_id: "id" }],
      durable_objects: { bindings: [] },
      queues: { producers: [{ binding: "QUEUE_WELCOME", queue: "welcome" }] },
      workflows: [{ binding: "WORKFLOW_ONBOARD", class_name: "Onboard", name: "onboard" }],
    }, resources)
    expect(missing.map(resource => resource.kind)).toEqual(["cloudflare-queue", "cloudflare-durable-object", "cloudflare-cron"])
  })
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).flatMap(root => [root, `${root}.vite-cache`]).map(root => rm(root, { force: true, recursive: true })))
})

// A Nitro module that removes the cron triggers that the Schedule plugin added, as a broken upgrade or project hook could.
const dropTriggers = (nitro: { hooks: { hook: (name: string, fn: () => void) => void }, options: { cloudflare?: { wrangler?: Record<string, unknown> } } }) => {
  nitro.hooks.hook("build:before", () => {
    delete nitro.options.cloudflare?.wrangler?.triggers
  })
}

async function build(modules: unknown[]): Promise<string> {
  const cache = resolve(import.meta.dirname, "../../../.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "cloudflare-resources-"))
  roots.push(root)
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "cloudflare-resources", private: true, type: "module" }))
  await mkdir(join(root, "server/schedules"), { recursive: true })
  await writeFile(join(root, "server/schedules/daily.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '0 9 * * *', handler() {} })\n")
  const options = {
    agent: false, auth: false, blob: false, database: false, env: false, host: "cloudflare", kv: false, queue: false,
    rateLimit: false, realtime: false, sandboxTask: false, schedule: true, workflow: false, workspace: false,
  } as const
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", nitro: { modules }, plugins: [vitehub(options), nitro()], root } as never)
  await builder.buildApp()
  return root
}

describe("Cloudflare build", () => {
  it("passes when wrangler.json has the Schedule cron", async () => {
    const root = await build([])
    const wrangler = JSON.parse(await readFile(join(root, ".output/server/wrangler.json"), "utf8")) as { triggers?: { crons?: string[] } }
    expect(wrangler.triggers?.crons).toContain("0 9 * * *")
  }, 120_000)

  it("fails with a coded error when a step drops the Schedule cron", async () => {
    await expect(build([dropTriggers])).rejects.toMatchObject({
      code: "VITE_HUB_CLOUDFLARE_RESOURCE_MISSING",
      message: expect.stringMatching(/wrangler\.json lacks the cron trigger "0 9 \* \* \*" for schedule "daily"/),
    })
  }, 120_000)
})
