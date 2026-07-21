import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"

import { hubQueue } from "../src/vite.ts"

const execFileAsync = promisify(execFile)
const roots: string[] = []
const workspaceRoot = resolve(import.meta.dirname, "../../..")

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubQueue", () => {
  it("registers and generates the Nitro queue runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    const plugin = hubQueue({ provider: "cloudflare" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const external = /^node:/
    const userConfig = { nitro: { cloudflare: { wrangler: { compatibility_flags: ["custom"] } }, plugins: ["server/plugin.ts"], rollupConfig: { external } }, root }

    config(userConfig)
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: { wrangler: { compatibility_flags: ["custom", "nodejs_compat"], queues: { consumers: [{ queue: "queue--77656c636f6d65" }], producers: [{ binding: "QUEUE_77656C636F6D65", queue: "queue--77656c636f6d65" }] } } },
        handlers: [{ handler: ".vitehub/nitro/queue/middleware.ts", middleware: true, route: "/**" }],
        plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"],
        rollupConfig: { external: [external, "cloudflare:workers"] },
      },
    })
    expect((userConfig.nitro.rollupConfig.external as unknown as unknown[])[0]).toBe(external)
    config(userConfig)
    expect(userConfig).toMatchObject({
      nitro: { plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"] },
    })

    await configResolved({
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      queue: { provider: "cloudflare" },
      resolve: { alias: [] },
      root,
    } as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    const nitroMiddleware = await readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")
    const registry = await readFile(join(root, ".vitehub", "queue", "registry.mjs"), "utf8")
    expect(nitroPlugin).toContain("setQueueRuntimeConfig(queueConfig)")
    expect(nitroPlugin).toContain("setQueueRuntimeRegistry(queueRegistry)")
    expect(nitroPlugin).not.toContain("enterQueueRuntimeEvent")
    expect(nitroPlugin).not.toContain("hooks.hook('request'")
    expect(nitroMiddleware).toContain("defineMiddleware((event) =>")
    expect(nitroMiddleware).toContain("const runtimeEvent = event as any")
    expect(nitroMiddleware).toContain("Object.assign(event, { env: runtimeEvent.env ?? runtimeEvent.context?.cloudflare?.env ?? runtimeEvent.context?._platform?.cloudflare?.env ?? runtimeEvent.req?.runtime?.cloudflare?.env ?? runtimeEvent.node?.req?.runtime?.cloudflare?.env ?? vitehubEnv, waitUntil: vitehubWaitUntil })")
    expect(nitroMiddleware).toContain("enterQueueRuntimeEvent(event)")
    expect(nitroMiddleware).not.toContain("enterQueueRuntimeEvent(runtimeEvent)")
    expect(nitroMiddleware).toContain("waitUntil: vitehubWaitUntil")
    expect(nitroMiddleware).not.toContain("next")
    expect(nitroPlugin).toContain("setQueueRuntimeEventDefaults({ env: vitehubEnv, waitUntil: vitehubWaitUntil })")
    expect(nitroPlugin).toContain("cloudflare:queue")
    expect(nitroPlugin).toContain("queueWorker.queue(batch, env, context)")
    expect(registry).toContain("welcome.queue.ts")

    await symlink(join(workspaceRoot, "node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "runtime-types.d.ts"), [
      "declare module 'cloudflare:workers' {",
      "  export const env: unknown",
      "  export function waitUntil(promise: Promise<unknown>): void",
      "}",
      "",
    ].join("\n"))
    await writeFile(join(root, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        types: [],
      },
      files: ["runtime-types.d.ts", ".vitehub/nitro/queue/middleware.ts"],
    }, null, 2)}\n`)
    await execFileAsync(process.execPath, [join(workspaceRoot, "node_modules/typescript/bin/tsc"), "-p", root], { cwd: root })
  })

  it("keeps inferred Cloudflare queue prefixes aligned across bindings and runtime definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-prefix-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    const plugin = hubQueue({ namePrefix: "preview-" })
    const userConfig = { nitro: { preset: "cloudflare_module" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(userConfig)
    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.queues", {
      consumers: [{ queue: "preview-queue--77656c636f6d65" }],
      producers: [{ binding: "QUEUE_77656C636F6D65", queue: "preview-queue--77656c636f6d65" }],
    })

    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      ...userConfig,
      queue: { namePrefix: "preview-" },
    } as never)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"preview-queue--77656c636f6d65": "welcome"')
    expect(nitroPlugin).toContain("createQueueCloudflareWorker({ definitions: queueDefinitions")
  })

  it("maps the long Drop deployment to its existing legacy Queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-legacy-"))
    roots.push(root)
    await writeFile(join(root, "image-optimization.queue.ts"), "export default { handler: async () => undefined }\n")

    const namePrefix = "vitehub-drop-pm-20260719-"
    const plugin = hubQueue({ namePrefix, provider: "cloudflare" })
    const userConfig = { nitro: { preset: "cloudflare_module" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(userConfig)
    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.queues", {
      consumers: [{ queue: "vitehub-drop-pm-20260719-image-optimization" }],
      producers: [{ binding: "QUEUE_696D6167652D6F7074696D697A6174696F6E", queue: "vitehub-drop-pm-20260719-image-optimization" }],
    })

    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      ...userConfig,
      queue: { namePrefix, provider: "cloudflare" },
    } as never)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"vitehub-drop-pm-20260719-image-optimization": "image-optimization"')
  })

  it("provisions inferred Cloudflare queues with the configured prefix in plain Vite builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-provision-prefix-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    const plugin = hubQueue({ namePrefix: "preview-" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      queue: { namePrefix: "preview-" },
      resolve: { alias: [] },
      root,
    } as never)
    const cli = await plugin.vitehub!.cli!()
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, result: [] }))) as unknown as typeof globalThis.fetch
    const actions = await cli.provision![0]!.plan({
      env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" },
      fetch,
      logger: { log: () => {}, warn: () => {} },
    })

    expect(actions[0]!.name).toBe("preview-queue--77656c636f6d65")
  })

  it("bounds Cloudflare physical queue names at the provider limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-prefix-limit-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    const config = { nitro: { preset: "cloudflare_module" }, root }
    const pluginConfig = hubQueue({ namePrefix: "x".repeat(80), provider: "cloudflare" }).config as unknown as (config: Record<string, unknown>) => void
    expect(() => pluginConfig(config)).not.toThrow()
    const queue = ((config.nitro as Record<string, unknown>).cloudflare as { wrangler: { queues: { producers: Array<{ queue: string }> } } }).wrangler.queues.producers[0]!.queue
    expect(queue).toHaveLength(63)
  })

  it("rejects invalid Cloudflare queue prefixes during configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-prefix-invalid-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    for (const namePrefix of ["-preview-", "preview_", "preview/"]) {
      const config = hubQueue({ namePrefix, provider: "cloudflare" }).config as unknown as (config: Record<string, unknown>) => void
      expect(() => config({ nitro: { preset: "cloudflare_module" }, root })).toThrow("must contain only letters, numbers, and dashes")
    }
  })

  it("infers providers for generated Nitro runtime imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({})
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ queue: {}, root, nitro: { preset: "vercel" } } as never)
    expect(await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).toContain("import * as __vitehubVercelQueue from '@vercel/queue'")
    expect(await readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")).not.toContain("runtimeEvent")
  })

  it("does not apply Cloudflare name limits to Vercel Nitro queues", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-vercel-name-"))
    roots.push(root)
    await writeFile(join(root, `${"q".repeat(30)}.queue.ts`), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "vercel" })

    await expect((plugin.configResolved as (config: unknown) => Promise<void>)({
      queue: { provider: "vercel" },
      root,
    } as never)).resolves.toBeUndefined()
  })

  it("uses the Nitro host instead of a mismatched explicit provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-host-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare" })
    const config = { nitro: { preset: "vercel" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    expect(config).not.toHaveProperty("nitro.cloudflare")
    expect(config).not.toHaveProperty("nitro.rollupConfig.external")
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ ...config, queue: { provider: "cloudflare" } } as never)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain("const queueConfig = false")
    expect(nitroPlugin).not.toContain("@vercel/queue")
    expect(nitroPlugin).not.toContain("cloudflare:workers")
    expect(nitroPlugin).not.toContain("cloudflare:queue")
    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: join(root, "welcome.queue.ts"),
      server: { config },
    })
    expect(await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).toContain("const queueConfig = false")
  })

  it("enables inferred queue config when hubQueue options are omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue()
    const userConfig = { nitro: { preset: "cloudflare_module" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(userConfig)
    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.queues.producers")
    expect(userConfig).toHaveProperty("nitro.rollupConfig.external", ["cloudflare:workers"])
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, nitro: { preset: "vercel" } } as never)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"provider": "vercel"')
    expect(nitroPlugin).not.toContain("const queueConfig = false")
  })

  it("does not load the optional Vercel SDK without definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    const plugin = hubQueue({})
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ queue: {}, root, nitro: { preset: "vercel" } } as never)
    const pluginFile = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    const middlewareFile = await readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")
    expect(`${pluginFile}\n${middlewareFile}`).not.toContain("@vercel/queue")
    expect(`${pluginFile}\n${middlewareFile}`).not.toContain("@vercel/functions")
  })

  it("refreshes the Nitro registry when Queue Definitions change", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    const plugin = hubQueue({ provider: "vercel" })
    const resolved = { root, nitro: { preset: "vercel" } }
    await (plugin.configResolved as (config: unknown) => Promise<void>)(resolved as never)
    const definition = join(root, "welcome.queue.ts")
    await writeFile(definition, "export default { handler: async () => undefined }\n")
    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: definition,
      server: { config: resolved },
    })
    expect(await readFile(join(root, ".vitehub", "queue", "registry.mjs"), "utf8")).toContain("welcome.queue.ts")
  })

  it("uses the final Nitro preset and skips disabled runtime registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue()
    const initial = { nitro: {}, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(initial)
    expect(initial.nitro).not.toHaveProperty("cloudflare")
    const resolved = { build: { outDir: "dist" }, command: "build", nitro: { ...initial.nitro, preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }], queue: undefined, root }
    await (plugin.configResolved as (config: unknown) => Promise<void>)(resolved as never)
    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.queues.producers")
    expect(resolved).toHaveProperty("nitro.rollupConfig.external", ["cloudflare:workers"])
    await (plugin.closeBundle as () => Promise<void>)()
    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "index.js"))).toBe(false)

    const disabled = { nitro: { preset: "cloudflare_module", handlers: [{ handler: ".vitehub/nitro/queue/middleware.ts", middleware: true, route: "/**" }, { handler: "server/middleware.ts", middleware: true }], plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"] }, queue: false, root }
    ;(hubQueue(false).config as unknown as (config: Record<string, unknown>) => void)(disabled)
    expect(disabled.nitro.plugins).toEqual(["server/plugin.ts"])
    expect(disabled.nitro.handlers).toEqual([{ handler: "server/middleware.ts", middleware: true }])
    expect(disabled.nitro).not.toHaveProperty("cloudflare")
  })

  it.each([
    { preset: "vercel", reason: "Vercel owns Nitro" },
    { preset: "cloudflare_module", reason: "the Nitro provider mismatches" },
  ])("keeps Vercel provider output when $reason", async ({ preset }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nuxt-vercel-"))
    roots.push(root)
    await symlink(join(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    const viteRoot = join(root, "app")
    await mkdir(viteRoot)
    await writeFile(join(viteRoot, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "vercel" })
    const config = {
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset },
      plugins: [],
      resolve: { alias: [] },
      root: viteRoot,
    }
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config as never)
    await plugin.vitehub?.queue?.createNitroConfig({ nitro: config.nitro, projectRoot: root, root: viteRoot })
    await (plugin.closeBundle as () => Promise<void>)()

    expect(existsSync(join(root, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel"))).toBe(true)
    expect(existsSync(join(viteRoot, ".vercel"))).toBe(false)
  })

  it("preserves Nitro-owned Vercel output across a sequential Cloudflare build", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-provider-switch-"))
    roots.push(root)
    await symlink(join(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    const vercelPlugin = hubQueue({ provider: "vercel" })
    const vercelConfig = {
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "vercel" },
      plugins: [{ name: "nitro:main" }],
      queue: { provider: "vercel" },
      resolve: { alias: [] },
      root,
    }
    ;(vercelPlugin.config as unknown as (config: Record<string, unknown>) => void)(vercelConfig)
    await (vercelPlugin.configResolved as (config: unknown) => Promise<void>)(vercelConfig as never)
    await (vercelPlugin.closeBundle as () => Promise<void>)()

    const outputRoot = join(root, ".vercel", "output")
    const functionsRoot = join(outputRoot, "functions")
    const serverFunction = join(functionsRoot, "__server.func")
    const blobFunction = join(functionsRoot, "__blob.func")
    const queueFunction = join(functionsRoot, "__queue.func")
    const queueConsumers = join(functionsRoot, "api", "vitehub", "queues", "vercel")
    const routeLinks = [
      join(functionsRoot, "api", "images.func"),
      join(functionsRoot, "api", "stats.func"),
      join(functionsRoot, "i", "[...].func"),
    ]
    const serverContents = "export default { nitro: true }\n"
    const configContents = `${JSON.stringify({
      routes: [
        { dest: "/__server", src: "/api/(.*)" },
        { dest: "/__server", src: "/i/(.*)" },
      ],
      version: 3,
    }, null, 2)}\n`

    await Promise.all([
      mkdir(serverFunction, { recursive: true }),
      mkdir(blobFunction, { recursive: true }),
      mkdir(join(functionsRoot, "api"), { recursive: true }),
      mkdir(join(functionsRoot, "i"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(serverFunction, "index.mjs"), serverContents),
      writeFile(join(blobFunction, "index.mjs"), "export default { blob: true }\n"),
      writeFile(join(outputRoot, "config.json"), configContents),
      ...routeLinks.map(link => symlink("../__server.func", link, "dir")),
    ])

    expect(existsSync(join(queueFunction, "index.mjs"))).toBe(true)
    expect(existsSync(queueConsumers)).toBe(true)

    const cloudflarePlugin = hubQueue({ provider: "cloudflare" })
    const cloudflareConfig = {
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "cloudflare_module" },
      plugins: [{ name: "nitro:main" }],
      queue: { provider: "cloudflare" },
      resolve: { alias: [] },
      root,
    }
    ;(cloudflarePlugin.config as unknown as (config: Record<string, unknown>) => void)(cloudflareConfig)
    await (cloudflarePlugin.configResolved as (config: unknown) => Promise<void>)(cloudflareConfig as never)
    await (cloudflarePlugin.closeBundle as () => Promise<void>)()

    await expect(readFile(join(serverFunction, "index.mjs"), "utf8")).resolves.toBe(serverContents)
    await expect(readFile(join(blobFunction, "index.mjs"), "utf8")).resolves.toContain("blob: true")
    await expect(readFile(join(outputRoot, "config.json"), "utf8")).resolves.toBe(configContents)
    for (const link of routeLinks) {
      await expect(readFile(join(link, "index.mjs"), "utf8")).resolves.toBe(serverContents)
    }
    expect(existsSync(queueFunction)).toBe(false)
    expect(existsSync(queueConsumers)).toBe(false)
  })

  it("preserves custom bindings and skips Cloudflare Pages consumers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare", binding: "JOBS" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => void
    const moduleConfig = { nitro: { preset: "cloudflare_module" }, root }
    config(moduleConfig)
    expect(moduleConfig).toMatchObject({
      nitro: { cloudflare: { wrangler: { queues: { producers: [{ binding: "JOBS" }] } } } },
    })
    const underscorePages = { nitro: { preset: "cloudflare_pages" }, root }
    config(underscorePages)
    expect(underscorePages).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            compatibility_flags: ["nodejs_compat"],
            queues: { producers: [{ binding: "JOBS", queue: "queue--77656c636f6d65" }] },
          },
        },
      },
    })
    expect(underscorePages.nitro).not.toHaveProperty("cloudflare.wrangler.queues.consumers")
    expect(underscorePages.nitro).not.toHaveProperty("rollupConfig.external")
    const hyphenPages = { nitro: { preset: "cloudflare-pages" }, root }
    config(hyphenPages)
    expect(hyphenPages).toHaveProperty("nitro.cloudflare.wrangler.queues.producers", [{ binding: "JOBS", queue: "queue--77656c636f6d65" }])
    expect(hyphenPages.nitro).not.toHaveProperty("cloudflare.wrangler.queues.consumers")

    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      nitro: underscorePages.nitro,
      plugins: [],
      queue: { binding: "JOBS", provider: "cloudflare" },
      resolve: { alias: [] },
      root,
    } as never)
    const pagesPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(pagesPlugin).not.toContain("cloudflare:queue")
    expect(pagesPlugin).toContain("cloudflare:workers")
    expect(pagesPlugin).toContain("setQueueRuntimeEventDefaults({ env: vitehubEnv, waitUntil: vitehubWaitUntil })")
    await (plugin.closeBundle as () => Promise<void>)()
    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "index.js"))).toBe(true)
  })

  it("keeps standalone output when Queue targets Cloudflare but Nitro does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare" })
    const config = { build: { outDir: "dist" }, command: "build", nitro: { preset: "vercel" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config as never)
    await (plugin.closeBundle as () => Promise<void>)()
    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "index.js"))).toBe(true)
  })

  it.each(["NITRO_PRESET", "SERVER_PRESET", "VITEHUB_HOSTING"])("keeps standalone output after Blob's Nitro bridge when selected by %s", async (environmentVariable) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const previous = process.env[environmentVariable]
    process.env[environmentVariable] = "cloudflare_module"

    try {
      const plugin = hubQueue()
      const config = { build: { outDir: "dist" }, command: "build", nitro: { plugins: [".vitehub/nitro/blob/plugin.ts"] }, plugins: [{ name: "@vite-hub/blob/vite" }], root }
      ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
      await (plugin.configResolved as (config: unknown) => Promise<void>)(config as never)
      await (plugin.closeBundle as () => Promise<void>)()
      expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "index.js"))).toBe(true)
    }
    finally {
      if (typeof previous === "undefined") delete process.env[environmentVariable]
      else process.env[environmentVariable] = previous
    }
  })

  it("rejects Queue Definitions generated after Nitro config resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-late-generated-"))
    roots.push(root)
    const plugin = hubQueue({ provider: "cloudflare" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "cloudflare_module" },
      plugins: [{ name: "nitro:main" }],
      root,
    } as never)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    await expect((plugin.closeBundle as () => Promise<void>)()).rejects.toThrow("changed after config resolution")
  })

  it("rejects late Queue Definitions for Vercel Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-vercel-late-"))
    roots.push(root)
    const plugin = hubQueue({ provider: "vercel" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "vercel" },
      plugins: [{ name: "nitro:main" }],
      root,
    } as never)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    await expect((plugin.closeBundle as () => Promise<void>)()).rejects.toThrow("changed after config resolution")
  })

  it("removes Queue bindings when final config discovery is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-empty-final-"))
    roots.push(root)
    const definition = join(root, "welcome.queue.ts")
    await writeFile(definition, "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare" })
    const config = { nitro: { preset: "cloudflare_module" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    expect(config).toHaveProperty("nitro.cloudflare.wrangler.queues")
    await rm(definition)

    const resolvedConfig = {
      ...config,
      build: { outDir: "dist" },
      command: "build",
      plugins: [{ name: "nitro:main" }],
    }
    await (plugin.configResolved as (config: unknown) => Promise<void>)(resolvedConfig as never)

    expect(resolvedConfig.nitro).not.toHaveProperty("cloudflare.wrangler.queues")
  })

  it("rejects Queue Definitions removed after Nitro config resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-late-removed-"))
    roots.push(root)
    const definition = join(root, "welcome.queue.ts")
    await writeFile(definition, "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "cloudflare_module" },
      plugins: [{ name: "nitro:main" }],
      root,
    } as never)
    await rm(definition)

    await expect((plugin.closeBundle as () => Promise<void>)()).rejects.toThrow("changed after config resolution")
  })

  it("rejects ambiguous and conflicting custom Cloudflare bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "first.queue.ts"), "export default { handler: async () => undefined }\n")
    await writeFile(join(root, "second.queue.ts"), "export default { handler: async () => undefined }\n")
    const custom = hubQueue({ provider: "cloudflare", binding: "JOBS" }).config as unknown as (config: Record<string, unknown>) => unknown
    expect(() => custom({ nitro: { preset: "cloudflare_module" }, root })).toThrow(/only be used with one Queue Definition/)

    await rm(join(root, "second.queue.ts"))
    const generatedBinding = "QUEUE_6669727374"
    const config = hubQueue({ provider: "cloudflare" }).config as unknown as (config: Record<string, unknown>) => unknown
    expect(() => config({ nitro: { preset: "cloudflare_module", cloudflare: { wrangler: { queues: { producers: [{ binding: generatedBinding, queue: "other" }] } } } }, root })).toThrow(/already assigned/)
  })
})
