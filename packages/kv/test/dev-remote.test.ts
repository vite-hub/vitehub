import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { createServer } from "vite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { normalizeKVOptions } from "../src/config.ts"
import { disposeKVStores, kv } from "../src/index.ts"
import { hubKv } from "../src/vite.ts"

import type { KVModuleOptions, ResolvedKVModuleOptions } from "../src/types.ts"

const fixture = vi.hoisted(() => ({ kv: false as false | ResolvedKVModuleOptions }))
vi.mock("#vitehub/kv/config", () => ({
  get kv() { return fixture.kv },
}))

const upstashEnv = { KV_REST_API_TOKEN: "test-token", KV_REST_API_URL: "https://upstash.test" }
let directory: string

function hook<T>(value: unknown): T {
  // SAFETY: The tests call the plugin hooks with the subset of Vite arguments that they read.
  return (Reflect.has(Object(value), "handler") ? Reflect.get(Object(value), "handler") : value) as T
}

/** Runs the hooks that `vite dev` or `vite build` runs, and returns the resolved KV config and Nitro options. */
async function resolvePlugin(command: "build" | "serve", options?: KVModuleOptions, hosting?: string) {
  const plugin = hubKv(options, { hosting })
  const nitro: { cloudflare?: { wrangler?: { kv_namespaces?: unknown[] } } } = {}
  await hook<(config: object, env: { command: string }) => unknown>(plugin.config)({ nitro, root: directory }, { command })
  await hook<(config: object) => unknown>(plugin.configResolved)({ build: { outDir: "dist" }, command, nitro, root: directory })
  const resolveId = hook<(id: string, importer?: string, options?: { ssr: boolean }) => unknown>(plugin.resolveId)
  return { kv: plugin.api.getConfig().kv, nitro, plugin, runtime: await resolveId("@vite-hub/kv", undefined, { ssr: true }) }
}

/** Stores keys of an `fs-lite` store in the test directory. */
function inDirectory(config: false | ResolvedKVModuleOptions): ResolvedKVModuleOptions {
  if (!config) throw new Error("KV is disabled.")
  const store = config.store
  if (store.driver === "fs-lite") return { store: { ...store, base: join(directory, store.base) } }
  if (store.driver === "cloudflare-kv-binding" && store.localBase) return { store: { ...store, localBase: join(directory, store.localBase) } }
  return config
}

/** An offline Upstash REST API. It answers single commands and pipelines. */
function stubUpstash() {
  const data = new Map<string, string>()
  const run = ([command, key, value]: string[]) => {
    if (command === "set") {
      data.set(key!, value!)
      return "OK"
    }
    if (command === "get") {
      const stored = data.get(key!)
      return stored === undefined ? null : Buffer.from(stored).toString("base64")
    }
    throw new Error(`Unexpected Redis command: ${command}`)
  }
  const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
    // SAFETY: The Upstash client sends a JSON command array, or an array of them for a pipeline.
    const body = JSON.parse(String(init.body)) as string[] | string[][]
    if (String(url).endsWith("/pipeline")) return Response.json((body as string[][]).map(command => ({ result: run(command) })))
    return Response.json({ result: run(body as string[]) })
  })
  vi.stubGlobal("fetch", fetch)
  return { data, fetch }
}

beforeEach(async () => {
  directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "vitehub-kv-dev-remote-"))
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request") }))
})

afterEach(async () => {
  await disposeKVStores()
  fixture.kv = false
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(directory, { force: true, recursive: true })
})

describe("KV in vite dev", () => {
  it("keeps the store local when Upstash env is set", async () => {
    for (const [name, value] of Object.entries(upstashEnv)) vi.stubEnv(name, value)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const { kv: config } = await resolvePlugin("serve")
    expect(config).toEqual({ store: { base: ".vitehub/data/kv", driver: "fs-lite" } })

    fixture.kv = inDirectory(config)
    expect(await kv.set("theme", "dark")).toEqual([undefined, undefined])
    expect(await kv.get("theme")).toEqual([undefined, "dark"])
    expect(existsSync(join(directory, ".vitehub/data/kv/theme"))).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it("keeps the Vercel preset local", () => {
    expect(normalizeKVOptions(undefined, { dev: true, env: {}, hosting: "vercel" })).toEqual({ store: { base: ".vitehub/data/kv", driver: "fs-lite" } })
  })

  it("uses Upstash with `remote: true` and prints the notice once", async () => {
    for (const [name, value] of Object.entries(upstashEnv)) vi.stubEnv(name, value)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const upstash = stubUpstash()

    const { kv: config } = await resolvePlugin("serve", { remote: true })
    expect(config).toEqual({ store: { driver: "upstash", remote: true, token: "********", url: "********" } })

    fixture.kv = inDirectory(config)
    expect(await kv.set("theme", "dark")).toEqual([undefined, undefined])
    expect(await kv.get("theme")).toEqual([undefined, "dark"])
    expect(upstash.data.get("theme")).toBe("dark")
    expect(String(upstash.fetch.mock.calls[0]?.[0])).toContain("https://upstash.test")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("[vitehub] KV store \"default\" is remote: `vite dev` uses the real Upstash database. Writes change real data.")
  })

  it("prints the notice for an explicit Upstash driver", () => {
    expect(normalizeKVOptions({ driver: "upstash" }, { dev: true, env: upstashEnv })?.store).toMatchObject({ driver: "upstash", remote: true })
  })

  it("uses a local store with the Workers KV limits on the Cloudflare preset without a binding", async () => {
    const { kv: config, runtime } = await resolvePlugin("serve", undefined, "cloudflare-module")
    expect(config).toEqual({ store: { binding: "KV", driver: "cloudflare-kv-binding", localBase: ".vitehub/data/kv-cloudflare/KV" } })
    // The package runtime, not the generated Cloudflare runtime, so the store can fall back.
    expect(runtime).toBeUndefined()

    fixture.kv = inDirectory(config)
    expect(await kv.set("theme", "dark")).toEqual([undefined, undefined])
    expect(await kv.get("theme")).toEqual([undefined, "dark"])
    expect(existsSync(join(directory, ".vitehub/data/kv-cloudflare/KV/theme"))).toBe(true)
    expect((await kv.set("k".repeat(513), "value"))[0]).toMatchObject({ code: "KV_KEY_TOO_LONG" })
    expect((await kv.setIfAbsent("ticket", "1"))[0]).toMatchObject({ code: "KV_UNSUPPORTED_OPERATION" })
  })

  it("uses the Cloudflare binding when the dev runtime has one", async () => {
    const { kv: config } = await resolvePlugin("serve", undefined, "cloudflare-module")
    fixture.kv = inDirectory(config)
    const values = new Map<string, string>()
    const binding = {
      delete: async (key: string) => { values.delete(key) },
      get: async (key: string) => values.get(key) ?? null,
      list: async () => ({ keys: [...values.keys()].map(name => ({ name })), list_complete: true }),
      put: async (key: string, value: string) => { values.set(key, value) },
    }

    expect(await runWithActiveCloudflareEnv({ KV: binding }, () => kv.set("theme", "dark"))).toEqual([undefined, undefined])
    expect(values.get("theme")).toBe("dark")
    expect(existsSync(join(directory, ".vitehub/data/kv-cloudflare/KV/theme"))).toBe(false)
  })

  it("writes `remote: true` on the Wrangler binding of a remote Cloudflare store", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { kv: config, nitro } = await resolvePlugin("serve", { remote: true }, "cloudflare-module")
    expect(config).toEqual({ store: { binding: "KV", driver: "cloudflare-kv-binding", remote: true } })
    expect(nitro.cloudflare?.wrangler?.kv_namespaces).toEqual([{ binding: "KV", remote: true }])

    fixture.kv = inDirectory(config)
    await runWithActiveCloudflareEnv({ KV: { get: async () => "dark" } }, () => kv.get("theme"))
    expect(warn).toHaveBeenCalledWith("[vitehub] KV store \"default\" is remote: `vite dev` uses the real Cloudflare KV namespace through the `KV` binding. Writes change real data.")
  })

  it("shows the development store in `vitehub inspect definitions`", async () => {
    const { plugin } = await resolvePlugin("serve", { stores: { cache: { driver: "cloudflare-kv-binding", binding: "CACHE", remote: true }, default: { driver: "fs-lite" } } })
    const inspect = typeof plugin.vitehub.inspect === "function" ? await plugin.vitehub.inspect() : plugin.vitehub.inspect
    const [inspector] = inspect?.definitions ?? []
    expect(inspector?.kind).toBe("kv")
    expect((await inspector!.list()).map(store => [store.name, store.fields])).toEqual([
      ["default", [{ label: "Driver", value: "fs-lite" }, { label: "Development", value: "Local. `fs-lite` in `.vitehub/data/kv`." }]],
      ["cache", [{ label: "Driver", value: "cloudflare-kv-binding" }, { label: "Development", value: "Remote. `vite dev` uses the real Cloudflare KV namespace through the `CACHE` binding, so writes change real data." }]],
    ])
  })
})

describe("KV in a Vite dev server", () => {
  it.each([
    ["the Cloudflare preset", undefined, "cloudflare-module"],
    ["an explicit Cloudflare store", { driver: "cloudflare-kv-binding" } satisfies KVModuleOptions, undefined],
  ])("serves %s from the local store when the runtime has no binding", async (_name, options, hosting) => {
    // A Vite SSR dev server runs in Node, like Nitro's default `node-worker` dev runner: no request has a KV binding.
    await mkdir(join(directory, "node_modules/@vite-hub"), { recursive: true })
    await symlink(resolve(import.meta.dirname, ".."), join(directory, "node_modules/@vite-hub/kv"), "dir")
    await mkdir(join(directory, "src"))
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "kv-dev-fixture", private: true, type: "module" }))
    await writeFile(join(directory, "src/worker.ts"), [
      `import { kv } from "@vite-hub/kv"`,
      `export async function handle() {`,
      `  const [writeError] = await kv.set("settings", { ok: true })`,
      `  if (writeError) throw writeError`,
      `  const [readError, settings] = await kv.get("settings")`,
      `  if (readError) throw readError`,
      `  return settings`,
      `}`,
    ].join("\n"))
    const cwd = process.cwd()
    // `fs-lite` resolves its directory from the working directory, which is the project root in `vite dev`.
    process.chdir(directory)
    const server = await createServer({ appType: "custom", configFile: false, logLevel: "silent", plugins: [hubKv(options, { hosting })], root: directory, server: { middlewareMode: true, ws: false } })
    try {
      // SAFETY: The fixture module above exports `handle()`.
      const worker = await server.ssrLoadModule("/src/worker.ts") as { handle: () => Promise<unknown> }
      await expect(worker.handle()).resolves.toEqual({ ok: true })
      expect(existsSync(join(directory, ".vitehub/data/kv-cloudflare/KV/settings"))).toBe(true)
    }
    finally {
      const { disposeKVStores: disposeServerStores } = await server.ssrLoadModule("@vite-hub/kv") as { disposeKVStores: () => Promise<void> }
      await disposeServerStores()
      await server.close()
      process.chdir(cwd)
    }
  })
})

describe("KV in a build", () => {
  it("ignores `remote` and keeps env inference", async () => {
    for (const [name, value] of Object.entries(upstashEnv)) vi.stubEnv(name, value)
    expect((await resolvePlugin("build")).kv).toEqual({ store: { driver: "upstash", token: "********", url: "********" } })
    expect((await resolvePlugin("build", { remote: false })).kv).toEqual({ store: { driver: "upstash", token: "********", url: "********" } })
  })

  it("keeps the generated Cloudflare runtime and binding", async () => {
    const { kv: config, nitro, runtime } = await resolvePlugin("build", { remote: true }, "cloudflare-module")
    expect(config).toEqual({ store: { binding: "KV", driver: "cloudflare-kv-binding" } })
    expect(nitro.cloudflare?.wrangler?.kv_namespaces).toEqual([{ binding: "KV" }])
    expect(runtime).toBe("\0#vitehub/kv/runtime")
  })
})

describe("KV `remote` errors", () => {
  it("rejects a value that is not a boolean", () => {
    // SAFETY: The test passes an invalid value that JavaScript config can contain.
    const options = { remote: "yes" } as unknown as KVModuleOptions
    expect(() => normalizeKVOptions(options, { env: {} })).toThrow(expect.objectContaining({ code: "KV_INVALID_REMOTE" }))
  })

  it.each([
    [{ driver: "fs-lite", remote: true }, {}],
    [{ driver: "upstash", remote: false }, {}],
    [{ remote: true }, { dev: true }],
  ])("rejects %j", (options, input) => {
    // SAFETY: The cases include configs that the types reject.
    expect(() => normalizeKVOptions(options as unknown as KVModuleOptions, { env: {}, ...input })).toThrow(expect.objectContaining({ code: "KV_REMOTE_CONFLICT" }))
  })
})
