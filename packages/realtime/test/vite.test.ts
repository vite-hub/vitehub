import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"
import { realtimeDurableObjectKey } from "../src/durable-key.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("hubRealtime", () => {
  it.each([
    { base: "/", nitro: {}, route: "/api/_vitehub/realtime/**" },
    { base: "/portal/", nitro: {}, route: "/portal/api/_vitehub/realtime/**" },
    { base: "/portal/", nitro: { baseURL: "/portal/" }, route: "/api/_vitehub/realtime/**" },
    { base: "/nested/portal/", nitro: { baseURL: "/nested/" }, route: "/portal/api/_vitehub/realtime/**" },
    { base: "/assets/", define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/portal/") }, nitro: { baseURL: "/portal/" }, route: "/api/_vitehub/realtime/**" },
  ])("mounts Realtime for $base with Nitro $nitro", async ({ base, define, nitro, route }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/comments.ts"), "export default {}\n")
    const { hubRealtime } = await import("../src/vite.ts")
    const config = { root, base, define, nitro }
    const hook = hubRealtime({ authority: "memory" }).config as unknown as (config: Record<string, unknown>) => Promise<void>
    await hook(config)
    expect(config.nitro).toMatchObject({ handlers: [expect.objectContaining({ route })] })
  })

  it("tells server code that the build has rooms", async () => {
    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ authority: "memory" })
    const id = (plugin.resolveId as (id: string) => string)("#vitehub/realtime/availability")
    expect((plugin.load as (id: string) => string)(id)).toBe("export default { available: true }\n")
  })

  it("reads the package fallback when no Realtime integration runs", async () => {
    const { default: availability } = await import("../src/internal/runtime/unavailable.ts")
    expect(availability).toMatchObject({ available: false, reason: "This build does not enable Realtime." })
  })

  it("bundles the public Vue entry without server Node modules", async () => {
    const { build } = await import("vite")
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-browser-"))
    tempDirs.push(root)
    const entry = fileURLToPath(new URL("../dist/vue.js", import.meta.url))
    await writeFile(join(root, "index.html"), `<script type="module" src="/entry.js"></script>`)
    await writeFile(join(root, "entry.js"), `export { useRealtimeTiptap } from ${JSON.stringify(entry)}`)
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [{
        name: "reject-server-builtins-in-browser",
        enforce: "pre",
        resolveId(id) {
          if (id.startsWith("node:")) throw new Error(`Browser entry imports server builtin ${id}`)
        },
      }],
      build: { write: false, rollupOptions: { input: join(root, "entry.js"), preserveEntrySignatures: "strict" } },
    })
    const outputs = Array.isArray(result)
      ? result.flatMap(bundle => bundle.output)
      : "output" in result ? result.output : []
    const expectedFacade = join(root, "entry.js").replaceAll("\\", "/")
    const entryChunk = outputs.find(output => output.type === "chunk"
      && output.facadeModuleId?.replaceAll("\\", "/") === expectedFacade)
    if (entryChunk?.type !== "chunk") throw new Error("Vite did not emit a JavaScript entry chunk")
    expect(entryChunk.exports).toContain("useRealtimeTiptap")
  })

  it("ships one y-tiptap copy, so carets find the sync plugin that Collaboration installs", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    const dist = fileURLToPath(new URL("../dist/", import.meta.url))
    const files = (await readdir(dist)).filter(file => file.endsWith(".js"))
    const sources = await Promise.all(files.map(file => readFile(join(dist, file), "utf8")))

    expect(sources.join("\n").match(/new PluginKey\("y-sync"\)/g)).toHaveLength(1)
    expect(sources.some(source => /from ["']@tiptap\/(?:y-tiptap|extension-collaboration)/.test(source))).toBe(false)
  })

  it("uses Nitro's Durable Object transport for standalone Cloudflare realtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime()
    const config = { base: "/wiki/", root, nitro: { preset: "cloudflare" } }
    const hook = plugin.config as unknown as (config: Record<string, unknown>) => Promise<void>
    await hook(config)

    expect(config.nitro).toMatchObject({
      preset: "cloudflare-durable",
      // Loaded on the first Realtime request, so the server (Tiptap, ProseMirror, Yjs) stays out of the Worker's start.
      handlers: [expect.objectContaining({ lazy: true, route: "/wiki/api/_vitehub/realtime/**" })],
      cloudflare: {
        wrangler: {
          durable_objects: {
            bindings: [{ class_name: "$DurableObject", name: "$DurableObject" }],
          },
          migrations: [{ new_sqlite_classes: ["$DurableObject"], tag: "vitehub-realtime-v1" }],
        },
      },
    })
    expect(config).toMatchObject({
      define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/wiki/") },
    })
    // Nitro 2 upgrades sockets in the Durable Object: a plugin gives Realtime its storage at `cloudflare:durable:init`.
    const plugins = (config.nitro as { plugins?: string[] }).plugins ?? []
    const durable = plugins.find(file => file.endsWith("durable-object.mjs"))
    expect(durable).toBeDefined()
    // The plugin loads with the Worker: it must not import the Realtime server, only fill the slot the server reads.
    const { readFile } = await import("node:fs/promises")
    await expect(readFile(durable!, "utf8")).resolves.not.toContain("import ")
    const hooks: Array<(durable: unknown, context: { state: unknown, env: unknown }) => void> = []
    const { default: install } = await import(pathToFileURL(durable!).href) as { default: (nitroApp: unknown) => void }
    install({ hooks: { hook: (name: string, fn: (typeof hooks)[number]) => name === "cloudflare:durable:init" && hooks.push(fn) } })
    const state = { storage: {} }
    const env = { DB: {} }
    for (const fn of hooks) fn({}, { state, env })
    expect(Reflect.get(globalThis, Symbol.for(realtimeDurableObjectKey))).toEqual({ env, state })
    Reflect.deleteProperty(globalThis, Symbol.for(realtimeDurableObjectKey))
  })

  it("loads the Yjs packages as one module graph in the Nitro environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")
    const { hubRealtime } = await import("../src/vite.ts")
    const config = { root, environments: { nitro: { resolve: { noExternal: [/^nitro/] } } } } as Record<string, unknown>
    const hook = hubRealtime({ authority: "memory" }).config as unknown as (config: Record<string, unknown>) => Promise<void>
    await hook(config)
    expect(config).toMatchObject({ environments: { nitro: { resolve: { noExternal: expect.arrayContaining([/^nitro/, "yjs", "y-protocols", "lib0", "@tiptap/y-tiptap"]) } } } })
  })

  it("requires an explicit authority for non-Cloudflare production", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime()
    const config = { root, nitro: { preset: "vercel" } }
    const hook = plugin.config as unknown as (config: Record<string, unknown>, environment: { command: string }) => Promise<void>

    await expect(hook(config, { command: "build" }))
      .rejects.toMatchObject({ code: "REALTIME_MISSING_AUTHORITY" })
  })

  it.each(["https://cdn.example.com/assets/", "//cdn.example.com/assets/", "./"])(
    "does not treat the Vite asset base %s as an application path",
    async (base) => {
      const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
      tempDirs.push(root)
      await mkdir(join(root, "server/realtime"), { recursive: true })
      await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

      const { hubRealtime } = await import("../src/vite.ts")
      const plugin = hubRealtime({ authority: "memory" })
      const config = { base, root } as Record<string, unknown>
      const hook = plugin.config as unknown as (config: Record<string, unknown>) => Promise<void>
      await hook(config)

      expect(config).toMatchObject({
        define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/") },
      })
    },
  )

  it("rejects Cloudflare authority with a non-Cloudflare Nitro preset", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ authority: "cloudflare" })
    const config = { root, nitro: { preset: "node-server" } }
    const hook = plugin.config as unknown as (config: Record<string, unknown>) => Promise<void>

    await expect(hook(config)).rejects.toMatchObject({ code: "REALTIME_AUTHORITY_CONFLICT", why: expect.stringContaining("the node deployment preset") })
    expect(config.nitro.preset).toBe("node-server")
  })

  it("allows an acknowledged single-process memory authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ authority: "memory" })
    const config = { root } as Record<string, unknown>
    const hook = plugin.config as unknown as (config: Record<string, unknown>, environment: { command: string }) => Promise<void>

    await expect(hook(config, { command: "build" })).resolves.toBeUndefined()
    expect(config.nitro).toMatchObject({ features: { websocket: true } })
  })

  it("rejects memory authority for distributed Deno deployments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/document.ts"), "export default {}\n")

    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ authority: "memory" })
    const config = { root, nitro: { preset: "deno-deploy" } }
    const hook = plugin.config as unknown as (config: Record<string, unknown>) => Promise<void>

    await expect(hook(config)).rejects.toMatchObject({ code: "REALTIME_AUTHORITY_CONFLICT", why: expect.stringContaining("the deno deployment preset") })
  })
  it.each([
    { name: "Cloudflare", nitro: { preset: "cloudflare" }, command: "build", options: {}, authority: "cloudflare" },
    { name: "development", nitro: {}, command: "serve", options: {}, authority: "memory" },
    { name: "an explicit memory authority", nitro: { preset: "node" }, command: "build", options: { authority: "memory" as const }, authority: "memory" },
  ])("adds contributed definitions and plugins on $name", async ({ nitro, command, options, authority }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    const contexts: unknown[] = []
    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({
      ...options,
      contribute: (context) => {
        contexts.push(context)
        return { definitions: [{ handler: join(context.directory, "content.mjs"), name: "content" }], plugins: [join(context.directory, "content-live.mjs")] }
      },
    })
    const config = { root, nitro } as Record<string, unknown>
    const hook = plugin.config as unknown as (config: Record<string, unknown>, environment: { command: string }) => Promise<void>
    await hook(config, { command })

    expect(contexts).toEqual([{ authority, directory: join(root, ".vitehub/nitro/realtime"), projectRoot: root, serverDirs: undefined }])
    const registry = await import("node:fs/promises").then(fs => fs.readFile(join(root, ".vitehub/nitro/realtime/registry.mjs"), "utf8"))
    expect(registry).toContain("content.mjs")
    const durable = authority === "cloudflare" ? [join(root, ".vitehub/nitro/realtime/durable-object.mjs")] : []
    expect(config.nitro).toMatchObject({ plugins: [...durable, join(root, ".vitehub/nitro/realtime/content-live.mjs")] })
  })

  it.each(["vercel", "netlify", "deno-deploy"])("leaves contributions out without an error on %s", async (preset) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    let called = false
    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ contribute: () => {
      called = true
      return { definitions: [{ handler: join(root, "content.mjs"), name: "content" }] }
    } })
    const config = { root, nitro: { preset } } as Record<string, unknown>
    const hook = plugin.config as unknown as (config: Record<string, unknown>, environment: { command: string }) => Promise<void>

    await expect(hook(config, { command: "build" })).resolves.toBeUndefined()
    expect(called).toBe(false)
    expect(config.nitro).toEqual({ preset })
  })

  it("keeps an application definition over a contributed one with the same name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-realtime-vite-"))
    tempDirs.push(root)
    await mkdir(join(root, "server/realtime"), { recursive: true })
    await writeFile(join(root, "server/realtime/content.ts"), "export default {}\n")
    const { hubRealtime } = await import("../src/vite.ts")
    const plugin = hubRealtime({ authority: "memory", contribute: () => ({ definitions: [{ handler: join(root, "generated.mjs"), name: "content" }] }) })
    const hook = plugin.config as unknown as (config: Record<string, unknown>) => Promise<void>
    await hook({ root })
    const registry = await import("node:fs/promises").then(fs => fs.readFile(join(root, ".vitehub/nitro/realtime/registry.mjs"), "utf8"))
    expect(registry).toContain("server/realtime/content.ts")
    expect(registry).not.toContain("generated.mjs")
  })
})
