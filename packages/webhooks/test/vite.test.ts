import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"

import { hubWebhooks, webhooksDevelopmentKeyFile, webhooksGeneratedFiles } from "../src/vite.ts"

import type { HubWebhooksOptions } from "../src/vite.ts"

const roots: string[] = []
const sendPlugin = { name: "fixture-send", vitehub: { webhooks: { memberEndpoints: true, reason: "Sends waiting comments to each member's agent." } } }

afterEach(async () => {
  delete process.env.VITEHUB_WEBHOOKS_KEY
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-webhooks-vite-"))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), content)
  }
  return root
}

/** Runs the `config` hook as Vite does, with the sibling plugins in `plugins`. */
async function configure(root: string, options: HubWebhooksOptions, plugins: unknown[], command: "build" | "serve" = "build") {
  const plugin = hubWebhooks(options)
  const config: Record<PropertyKey, unknown> = { root, plugins: [plugin, [plugins]] }
  Reflect.set(config, VITEHUB_PROJECT_ROOT, root)
  const hook = plugin.config
  if (typeof hook !== "object" || hook === null) throw new TypeError("Expected an object hook.")
  await Reflect.apply(hook.handler, undefined, [config, { command, mode: command === "serve" ? "development" : "production" }])
  return { plugin, config }
}

describe("member endpoints at build time", () => {
  it("installs with no server/webhooks/ files and no Queue when a sibling plugin uses them", async () => {
    const root = await project()
    const { plugin, config } = await configure(root, { database: true, queue: false }, [sendPlugin])
    const files = webhooksGeneratedFiles(root)
    const registry = await readFile(files.registry, "utf8")
    expect(registry).toContain("endpoints: createDrizzleWebhookEndpointStore(db),")
    expect(registry).not.toContain("dynamicQueue")
    expect(registry).not.toContain("wake:")
    await expect(readFile(files.queue, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(JSON.stringify(Reflect.get(config, "nitro"))).toContain(files.plugin)
    const context = { root, projectRoot: root, rootDir: root, plugins: [plugin, sendPlugin] }
    expect(await plugin.vitehub.queues(context)).toEqual([])
    expect(await plugin.vitehub.databases(context)).toEqual([
      expect.objectContaining({ name: "webhooks", definition: { export: "webhooksSchema", module: "@vite-hub/webhooks/database" } }),
      expect.objectContaining({ name: "webhook-endpoints", definition: { export: "webhookEndpointsSchema", module: "@vite-hub/webhooks/database" }, tables: { webhookEndpoints: "vitehub_webhook_endpoints", webhookPairings: "vitehub_webhook_pairings" } }),
    ])
    expect(plugin.api.deploymentEnv({ host: "node" })).toEqual([{ names: ["VITEHUB_WEBHOOKS_KEY"], required: true, secret: true, hasDefault: false, owners: ["webhooks"] }])
  })

  it("retries member deliveries through the Queue when the app has one", async () => {
    const root = await project()
    const { plugin } = await configure(root, { database: true, queue: true }, [sendPlugin])
    expect(await readFile(webhooksGeneratedFiles(root).registry, "utf8")).toContain("wake: (wake, options) => dynamicQueue.send(\"vitehub-webhooks\", wake, options),")
    expect(await plugin.vitehub.queues({ root, projectRoot: root, plugins: [plugin, sendPlugin] })).toEqual([expect.objectContaining({ name: "vitehub-webhooks" })])
  })

  it("stays off without a sibling plugin, and a factory can turn it off", async () => {
    const root = await project()
    const off = { name: "fixture-off", vitehub: { webhooks: () => undefined } }
    const { plugin } = await configure(root, { database: true, queue: false }, [off])
    await expect(readFile(webhooksGeneratedFiles(root).registry, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(await plugin.vitehub.databases({ root, projectRoot: root, plugins: [plugin, off] })).toEqual([])
    expect(plugin.api.deploymentEnv({ host: "node" })).toEqual([])
  })

  it("needs the Database, and names the plugin that uses member endpoints", async () => {
    const root = await project()
    await expect(configure(root, { database: false, queue: false }, [sendPlugin])).rejects.toMatchObject({
      code: "WEBHOOKS_DATABASE_OFF",
      message: expect.stringContaining("fixture-send: Sends waiting comments"),
    })
    await expect(configure(root, { database: true }, [{ name: "fixture-bad", vitehub: { webhooks: { memberEndpoints: "yes" } } }])).rejects.toMatchObject({ code: "WEBHOOKS_CONTRIBUTION_INVALID" })
  })

  it("still needs the Queue for server/webhooks/ files", async () => {
    const root = await project({ "server/webhooks/t3.ts": "export default {}\n" })
    await expect(configure(root, { database: true, queue: false }, [sendPlugin])).rejects.toMatchObject({ code: "WEBHOOKS_QUEUE_OFF" })
  })

  it("generates a development key in vite dev and keeps it across restarts", async () => {
    const root = await project()
    await configure(root, { database: true }, [sendPlugin], "serve")
    const key = process.env.VITEHUB_WEBHOOKS_KEY
    expect(atob(key ?? "")).toHaveLength(32)
    expect((await readFile(webhooksDevelopmentKeyFile(root), "utf8")).trim()).toBe(key)
    delete process.env.VITEHUB_WEBHOOKS_KEY
    await configure(root, { database: true }, [sendPlugin], "serve")
    expect(process.env.VITEHUB_WEBHOOKS_KEY).toBe(key)
    // A build never generates a key.
    delete process.env.VITEHUB_WEBHOOKS_KEY
    await configure(await project(), { database: true }, [sendPlugin])
    expect(process.env.VITEHUB_WEBHOOKS_KEY).toBeUndefined()
  })
})
