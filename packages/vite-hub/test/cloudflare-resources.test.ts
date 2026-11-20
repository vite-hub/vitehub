import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { assertCloudflareResources, findMissingCloudflareResources } from "../src/cloudflare-resources.ts"
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

  it("checks the Realtime Durable Object that ViteHub binds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-cloudflare-resources-"))
    roots.push(dir)
    await writeFile(join(dir, "wrangler.json"), JSON.stringify({ durable_objects: { bindings: [] } }))
    await expect(assertCloudflareResources(dir, [], { realtime: true })).rejects.toMatchObject({ code: "VITE_HUB_CLOUDFLARE_RESOURCE_MISSING" })
    await writeFile(join(dir, "wrangler.json"), JSON.stringify({ durable_objects: { bindings: [{ class_name: "$DurableObject", name: "$DurableObject" }] } }))
    await expect(assertCloudflareResources(dir, [], { realtime: true })).resolves.toBeUndefined()
  })

  it("skips the resources of a standalone Worker, which has its own Wrangler config", () => {
    expect(findMissingCloudflareResources({}, [{ definition: "cleanup", host: "cloudflare", kind: "cloudflare-cron", name: "0 3 * * *", owner: "schedule", standalone: true }])).toEqual([])
  })
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).flatMap(root => [root, `${root}.vite-cache`]).map(root => rm(root, { force: true, recursive: true })))
})

type TestNitro = { hooks: { hook: (name: string, fn: () => unknown) => void }, options: { cloudflare?: { wrangler?: Record<string, unknown> }, output: { serverDir: string } } }

// Nitro modules that break the Schedule cron, as a broken upgrade or project hook could. A project module runs after ViteHub's.
const dropTriggers = (nitro: TestNitro) => {
  nitro.hooks.hook("build:before", () => {
    delete nitro.options.cloudflare?.wrangler?.triggers
  })
}
const dropTriggersFromFile = (nitro: TestNitro) => {
  nitro.hooks.hook("compiled", async () => {
    const file = join(nitro.options.output.serverDir, "wrangler.json")
    const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    delete config.triggers
    await writeFile(file, JSON.stringify(config))
  })
}
const deleteFile = (nitro: TestNitro) => {
  nitro.hooks.hook("compiled", async () => await unlink(join(nitro.options.output.serverDir, "wrangler.json")))
}
const writeNull = (nitro: TestNitro) => {
  nitro.hooks.hook("compiled", async () => await writeFile(join(nitro.options.output.serverDir, "wrangler.json"), "null"))
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

  it.each([
    ["drops the cron from the Nitro config", dropTriggers],
    ["drops the cron from the generated file", dropTriggersFromFile],
    ["deletes the generated file", deleteFile],
    ["writes null to the generated file", writeNull],
  ])("fails with a coded error when a project module %s", async (_name, module) => {
    await expect(build([module])).rejects.toMatchObject({
      code: "VITE_HUB_CLOUDFLARE_RESOURCE_MISSING",
      message: expect.stringMatching(/wrangler\.json lacks the cron trigger "0 9 \* \* \*" for schedule "daily"/),
    })
  }, 120_000)
})
