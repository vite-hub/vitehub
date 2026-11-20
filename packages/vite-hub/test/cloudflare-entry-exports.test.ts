import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

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

async function build(options: ViteHubOptions, extra: Record<string, string>, nitroOptions: Record<string, unknown> = {}, base: Record<string, string> = files): Promise<string> {
  const root = await createProject({ ...base, ...extra })
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", nitro: nitroOptions, plugins: [vitehub(options), nitro()], root } as never)
  await builder.buildApp()
  return root
}

async function startWorker(root: string) {
  const server = join(root, ".output/server")
  await promisify(execFile)(process.execPath, ["--check", join(server, "index.mjs")])
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

  it("adds the names that `export *` and string aliases export", async () => {
    const root = await build({ host: "cloudflare" }, {
      "server/cloudflare.ts": "export * from './utils/counter'\nexport { Counter as \"counter-class\" } from './utils/counter'\n",
      "server/utils/counter.ts": counter,
    })
    expect(await readFile(join(root, ".output/server/index.mjs"), "utf8")).toContain(`export { Counter, "counter-class" } from "./app-cloudflare-exports.mjs"`)
    const worker = await startWorker(root)
    try {
      expect(await (await worker.dispatchFetch("https://example.com/count")).json()).toEqual({ count: 1 })
    }
    finally {
      await worker.dispose()
    }
  }, 300_000)

  it("reads the file from Nitro's serverDir", async () => {
    const backend = Object.fromEntries(Object.entries(files).map(([file, source]) => [file.replace(/^server\//, "backend/"), source]))
    const root = await build({ host: "cloudflare" }, { "backend/cloudflare.ts": counter }, { serverDir: "backend" }, backend)
    const worker = await startWorker(root)
    try {
      expect(await (await worker.dispatchFetch("https://example.com/count")).json()).toEqual({ count: 1 })
    }
    finally {
      await worker.dispose()
    }
  }, 300_000)

  it("keeps the file out of the prerender build", async () => {
    const root = await build({ host: "cloudflare" }, {
      "server/cloudflare.ts": `${counter}import { WorkerEntrypoint } from 'cloudflare:workers'\nexport class Entry extends WorkerEntrypoint {}\n`,
      "server/routes/hello.ts": "export default () => 'hello'\n",
    }, { prerender: { routes: ["/hello"] } })
    expect(await readFile(join(root, ".output/server/index.mjs"), "utf8")).toContain("export { Counter, Entry }")
  }, 300_000)

  it("rejects a name that another plugin adds to the entry", async () => {
    const appendCounter = {
      name: "test:append-counter",
      renderChunk: (code: string, chunk: { fileName: string }) => chunk.fileName === "index.mjs" ? `${code}\nclass Counter {}\nexport { Counter }\n` : null,
    }
    await expect(build({ host: "cloudflare" }, { "server/cloudflare.ts": counter }, { rollupConfig: { plugins: [appendCounter] } }))
      .rejects.toThrow(/VITE_HUB_CLOUDFLARE_EXPORT_CONFLICT: .*cloudflare\.ts exports Counter/)
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
