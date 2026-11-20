import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { Miniflare } from "miniflare"
import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { createProject } from "./support/content-cms.ts"

import type { ViteHubOptions } from "../src/index.ts"

const counter = [
  "import { DurableObject } from 'cloudflare:workers'",
  "",
  "export class Counter extends DurableObject {",
  "  async increment() {",
  "    const count = ((await this.ctx.storage.get('count')) ?? 0) + 1",
  "    await this.ctx.storage.put('count', count)",
  "    return count",
  "  }",
  "}",
  "",
].join("\n")

const files = {
  "package.json": JSON.stringify({ name: "cloudflare-entry-exports", private: true, type: "module" }),
  "server/routes/count.ts": [
    "import { env } from 'cloudflare:workers'",
    "",
    "export default async () => {",
    "  const counter = env.COUNTER.get(env.COUNTER.idFromName('global'))",
    "  return { count: await counter.increment() }",
    "}",
    "",
  ].join("\n"),
  // Bindings and migrations stay in the project's Wrangler config.
  "wrangler.json": JSON.stringify({
    durable_objects: { bindings: [{ class_name: "Counter", name: "COUNTER" }] },
    migrations: [{ new_sqlite_classes: ["Counter"], tag: "v1" }],
  }),
}

async function build(options: ViteHubOptions, extra: Record<string, string>): Promise<string> {
  const root = await createProject({ ...files, ...extra })
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [vitehub(options), nitro()], root } as never)
  await builder.buildApp()
  return root
}

async function startWorker(root: string) {
  const server = join(root, ".output/server")
  const wrangler = JSON.parse(await readFile(join(server, "wrangler.json"), "utf8")) as { compatibility_flags?: string[] }
  const modules = (await readdir(server, { recursive: true })).filter(file => file.endsWith(".mjs"))
  return new Miniflare({
    compatibilityDate: "2026-04-20",
    compatibilityFlags: [...new Set([...wrangler.compatibility_flags ?? [], "nodejs_compat"])],
    durableObjects: { COUNTER: { className: "Counter", useSQLite: true } },
    modules: ["index.mjs", ...modules.filter(file => file !== "index.mjs")].map(file => ({ path: join(server, file), type: "ESModule" as const })),
    modulesRoot: server,
    serviceBindings: { ASSETS: () => new Response("not found", { status: 404 }) },
  })
}

describe("server/cloudflare.ts on Cloudflare", () => {
  it("adds the named exports to the Worker entry, so a Durable Object class runs", async () => {
    const root = await build({ host: "cloudflare" }, { "server/cloudflare.ts": counter })
    const wrangler = JSON.parse(await readFile(join(root, ".output/server/wrangler.json"), "utf8")) as Record<string, unknown>
    expect(wrangler).toMatchObject({
      durable_objects: { bindings: [{ class_name: "Counter", name: "COUNTER" }] },
      migrations: [{ new_sqlite_classes: ["Counter"], tag: "v1" }],
    })
    const worker = await startWorker(root)
    try {
      const count = async () => await (await worker.dispatchFetch("https://example.com/count")).json()
      expect(await count()).toEqual({ count: 1 })
      expect(await count()).toEqual({ count: 2 })
    }
    finally {
      await worker.dispose()
    }
  }, 300_000)

  it("adds exports that the file takes from another module", async () => {
    const root = await build({ host: "cloudflare" }, {
      "server/cloudflare.ts": "export { Counter } from './utils/counter'\n",
      "server/utils/counter.ts": counter,
    })
    const worker = await startWorker(root)
    try {
      expect(await (await worker.dispatchFetch("https://example.com/count")).json()).toEqual({ count: 1 })
    }
    finally {
      await worker.dispose()
    }
  }, 300_000)

  it("rejects a default export, since the Worker's default export is the app", async () => {
    await expect(build({ host: "cloudflare" }, { "server/cloudflare.ts": `${counter}export default Counter\n` }))
      .rejects.toThrow(/VITE_HUB_CLOUDFLARE_EXPORT_CONFLICT: .*cloudflare\.ts exports default/)
  }, 300_000)

  it("leaves the entry alone on other hosts", async () => {
    const root = await build({ host: "node" }, { "server/cloudflare.ts": counter, "server/routes/count.ts": "export default () => 'ok'\n" })
    expect(await readFile(join(root, ".output/server/index.mjs"), "utf8")).not.toContain("Counter")
  }, 300_000)
})
