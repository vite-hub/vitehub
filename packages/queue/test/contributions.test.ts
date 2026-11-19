import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { collectViteHubDefinitionInspectors, collectViteHubResourceSummaries } from "@vite-hub/internal/inspect"

import { normalizeQueueOptions } from "../src/config.ts"
import { closeLocalQueues, createLocalQueueRuntimeClient, startLocalQueue } from "../src/internal/runtime/local-client.ts"
import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import { dynamicQueue } from "../src/runtime/client.ts"
import { collectQueueContributions, hubQueue } from "../src/vite.ts"

import type { QueueContributingPlugin, QueueContributionContext } from "../src/vite.ts"
import type { QueueDefinitionRegistry } from "../src/types.ts"

const roots: string[] = []
const definitionModule = pathToFileURL(resolve(import.meta.dirname, "../src/definition.ts")).href
const queueName = "acme-webhooks"

afterEach(async () => {
  closeLocalQueues()
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

/** An app root without Queue files, and a package directory outside it that ships one Queue module. */
async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-queue-contributed-"))
  const packageDir = await mkdtemp(join(tmpdir(), "vitehub-queue-contributor-"))
  roots.push(root, packageDir)
  const module = join(packageDir, "deliver.mjs")
  await writeFile(module, [
    `import { defineQueue } from ${JSON.stringify(definitionModule)}`,
    "export default defineQueue({ handler: async ({ payload }) => {",
    "  globalThis.__contributedQueueJobs.push({ at: Date.now(), payload })",
    "} })",
    "",
  ].join("\n"))
  return { module, root }
}

/** The Vite plugin of an owner package, such as a webhooks package, that adds one Queue Definition. */
function contributor(module: string, seen: QueueContributionContext[] = []): QueueContributingPlugin {
  return {
    name: "@acme/webhooks",
    vitehub: {
      queues: (context) => {
        seen.push(context)
        return [{ definition: { module: pathToFileURL(module).href }, name: queueName, reason: "Delivers webhooks after their delay." }]
      },
    },
  }
}

type ConfigHook = (config: Record<string, unknown>, env?: { command: string }) => Promise<unknown>
type ConfigResolvedHook = (config: unknown) => Promise<void>

async function configure(plugin: ReturnType<typeof hubQueue>, config: Record<string, unknown>) {
  await (plugin.config as unknown as ConfigHook)(config, { command: "build" })
  await (plugin.configResolved as unknown as ConfigResolvedHook)({ build: { outDir: "dist" }, command: "build", resolve: { alias: [] }, ...config })
}

describe("contributed Queue Definitions", () => {
  it("builds a contributed Queue for a Node server and runs it with delaySeconds", async () => {
    const { module, root } = await createProject()
    const seen: QueueContributionContext[] = []
    const plugin = hubQueue()
    await configure(plugin, { nitro: { preset: "node-server" }, plugins: [contributor(module, seen), plugin], root })

    expect(seen[0]).toMatchObject({ projectRoot: root, root })
    const registryFile = join(root, ".vitehub", "queue", "registry.mjs")
    const registry = await readFile(registryFile, "utf8")
    expect(registry).toContain(`[${JSON.stringify(queueName)}]`)
    expect(registry).toContain("deliver.mjs")
    expect(await readFile(join(root, ".vitehub", "queue.d.ts"), "utf8")).toContain(`${JSON.stringify(queueName)}: typeof import(`)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"driver": "local"')
    expect(nitroPlugin).toContain("startLocalQueue(queueConfig)")

    // Run the generated registry as the Nitro plugin does.
    const jobs: Array<{ at: number, payload: unknown }> = []
    vi.stubGlobal("__contributedQueueJobs", jobs)
    const { default: generated } = await import(/* @vite-ignore */ pathToFileURL(registryFile).href) as { default: QueueDefinitionRegistry }
    const queueConfig = normalizeQueueOptions({ base: join(root, "jobs") }, { hosting: "node-server" })!
    setQueueRuntimeConfig(queueConfig, createLocalQueueRuntimeClient)
    setQueueRuntimeRegistry(generated)
    startLocalQueue(queueConfig)

    const queue = await dynamicQueue.use(queueName)
    const sentAt = Date.now()
    const [error, sent] = await queue.send({ id: "hook_1", revision: 1 }, { delaySeconds: 0.3 })
    expect(error).toBeUndefined()
    expect(sent).toMatchObject({ status: "queued" })
    await new Promise(done => setTimeout(done, 100))
    expect(jobs).toEqual([])
    await vi.waitFor(() => expect(jobs).toHaveLength(1), { timeout: 5_000 })
    expect(jobs[0]!.payload).toEqual({ id: "hook_1", revision: 1 })
    expect(jobs[0]!.at - sentAt).toBeGreaterThanOrEqual(290)
  })

  it("adds Cloudflare bindings, consumers, inspection, and resources for a contributed Queue", async () => {
    const { module, root } = await createProject()
    const plugin = hubQueue({ driver: "cloudflare" })
    const config = { nitro: { preset: "cloudflare_module" }, plugins: [contributor(module), plugin], root }
    await configure(plugin, config)

    expect(config.nitro).toHaveProperty("cloudflare.wrangler.queues", {
      consumers: [{ queue: "queue--61636d652d776562686f6f6b73" }],
      producers: [{ binding: "QUEUE_61636D652D776562686F6F6B73", queue: "queue--61636d652d776562686f6f6b73" }],
    })
    expect(await readFile(join(root, ".vitehub", "queue", "registry.mjs"), "utf8")).toContain("deliver.mjs")
    expect(await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).toContain("cloudflare:queue")

    const [inspector] = await collectViteHubDefinitionInspectors([plugin])
    expect(await inspector!.list()).toEqual([expect.objectContaining({
      fields: [{ label: "Contributed by", value: "@acme/webhooks" }, { label: "Reason", value: "Delivers webhooks after their delay." }],
      name: queueName,
      source: "vite-plugin-contribution",
    })])
    expect(await collectViteHubResourceSummaries([plugin])).toMatchObject([{ definition: queueName, kind: "cloudflare-queue", name: "queue--61636d652d776562686f6f6b73" }])
  })

  it("adds a Vercel consumer route for a contributed Queue", async () => {
    const { module, root } = await createProject()
    const plugin = hubQueue({ driver: "vercel" })
    const config = { nitro: { preset: "vercel" }, plugins: [contributor(module), plugin], root }
    await configure(plugin, config)

    expect(config.nitro).toHaveProperty(["vercel", "functionRules", `/api/vitehub/queues/vercel/${queueName}`, "experimentalTriggers", 0, "type"], "queue/v2beta")
  })

  it("rejects a contributed name that a Queue file already uses", async () => {
    const { module, root } = await createProject()
    await writeFile(join(root, `${queueName}.queue.ts`), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue()
    await expect((plugin.config as unknown as ConfigHook)({ nitro: { preset: "node-server" }, plugins: [contributor(module)], root }))
      .rejects.toMatchObject({ code: "QUEUE_DEFINITION_DUPLICATE" })
  })

  it.each([
    { definition: { module: "./deliver.mjs" }, problem: "is relative" },
    { definition: { module: "@acme/webhooks/deliver" }, problem: "absolute file path" },
    { definition: { export: "deliver", module: "/tmp/deliver.mjs" }, problem: "default export" },
    { definition: { module: "/tmp/vitehub-queue-missing/deliver.mjs" }, problem: "does not exist" },
  ])("rejects an invalid contribution ($problem)", async ({ definition, problem }) => {
    const plugins = [{ name: "@acme/webhooks", vitehub: { queues: [{ definition, name: queueName }] } }]
    await expect(collectQueueContributions(plugins, { projectRoot: "/app", root: "/app" }))
      .rejects.toMatchObject({ code: "QUEUE_CONTRIBUTION_INVALID", message: expect.stringContaining(problem) })
  })
})
