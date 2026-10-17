import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { collectViteHubDefinitionInspectors } from "@vite-hub/internal/inspect"
import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"

import { createQueueNitroConfig, hubQueue } from "../src/vite.ts"

const execFileAsync = promisify(execFile)
const roots: string[] = []
const workspaceRoot = resolve(import.meta.dirname, "../../..")

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function runBuildEnd(plugin: ReturnType<typeof hubQueue>) {
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: hubQueue owns this callable Vite lifecycle hook in the focused test.
  await (plugin.buildEnd as unknown as () => void | Promise<void>)()
}

describe("hubQueue", () => {
  it("resets omitted Queue options to the plugin options on each config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-options-"))
    roots.push(root)
    const plugin = hubQueue(false)
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ root, command: "build", queue: { provider: "cloudflare" } })
    expect(await collectViteHubDefinitionInspectors([plugin])).not.toEqual([])
    await configResolved({ root, command: "build" })
    expect(await collectViteHubDefinitionInspectors([plugin])).toEqual([])
  })
  it("omits explicitly disabled Queue Definitions", async () => {
    const options = false
    const nitro = {}
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-disabled-inspection-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue(options)
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ root, nitro, command: "build" })

    const inspectors = await collectViteHubDefinitionInspectors([plugin])
    expect(inspectors).toEqual([])
  })

  it("uses project Queue options when Nitro resolves before the Vite config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nuxt-options-"))
    roots.push(root)
    const plugin = hubQueue(false)
    const config = plugin.config as unknown as (config: Record<string, unknown>) => unknown
    config({ root, queue: { provider: "cloudflare" } })
    const nitro = await createQueueNitroConfig(plugin, {
      nitro: { preset: "cloudflare_module" }, projectRoot: root, root,
    })
    expect(nitro.plugins).toEqual([resolve(root, ".vitehub/nitro/queue/plugin.ts")])
  })

  it.each(["before", "after", "interleaved"])("keeps each Nuxt project's Queue output when Nitro resolves %s Vite", async (order) => {
    const plugin = hubQueue({ provider: "vercel" })
    const projects = []
    for (const name of ["first", "second"]) {
      const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nuxt-shared-"))
      roots.push(root)
      const viteRoot = join(root, "app")
      const serverDir = join(root, "backend")
      await mkdir(viteRoot)
      await mkdir(join(serverDir, "queues"), { recursive: true })
      await symlink(join(workspaceRoot, "node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(serverDir, "queues", `${name}.ts`), "export default { handler: async () => undefined }\n")
      const config = { root: viteRoot, command: "build", build: { outDir: "dist" }, nitro: { preset: "vercel" }, plugins: [], resolve: { alias: [] } }
      const configureNitro = () => createQueueNitroConfig(plugin, { nitro: config.nitro, projectRoot: root, root: viteRoot, serverDirs: [serverDir] })
      if (order === "before") await configureNitro()
      await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
      if (order === "after") await configureNitro()
      const context = { environment: { config } }
      projects.push({ root, viteRoot, name, context, configureNitro })
    }
    // Resolve A Vite, B Vite, A Nitro, B Nitro before either output is generated.
    if (order === "interleaved") {
      for (const { configureNitro } of projects) await configureNitro()
    }
    for (const { context } of projects) {
      await (plugin.buildEnd as (this: never) => Promise<void>).call(context as never)
    }
    for (const { root, viteRoot, name } of projects) {
      const registry = await readFile(join(root, ".vitehub", "queue", "registry.mjs"), "utf8")
      expect(registry).toContain(`${name}.ts`)
      expect(registry).not.toContain(`${name === "first" ? "second" : "first"}.ts`)
      expect(await readdir(join(root, ".vitehub", "nitro", "queue", "vercel"))).toHaveLength(1)
      expect(existsSync(join(viteRoot, ".vitehub", "nitro", "queue", "vercel"))).toBe(false)
    }
  })

  it("registers absolute generated paths when Nitro owns the Vite config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-owned-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    const plugin = hubQueue({ provider: "cloudflare" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => unknown
    const userConfig = {
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
      nitro: { preset: "cloudflare_module" },
      root,
    }

    config(userConfig)

    expect(userConfig.nitro).toMatchObject({
      handlers: [{ handler: resolve(root, ".vitehub/nitro/queue/middleware.ts") }],
      plugins: [resolve(root, ".vitehub/nitro/queue/plugin.ts")],
    })

    const nitro = await createQueueNitroConfig(plugin, {
      nitro: userConfig.nitro,
      projectRoot: root,
      root,
    })
    expect(nitro).toMatchObject({
      handlers: [{ handler: resolve(root, ".vitehub/nitro/queue/middleware.ts") }],
      plugins: [resolve(root, ".vitehub/nitro/queue/plugin.ts")],
    })
  })

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

    const resolved = {
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      queue: { provider: "cloudflare" },
      resolve: { alias: [] },
      root,
    }
    await configResolved(resolved as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    const nitroMiddleware = await readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")
    const registry = await readFile(join(root, ".vitehub", "queue", "registry.mjs"), "utf8")
    expect(nitroPlugin).toContain("setQueueRuntimeConfig(queueConfig, createCloudflareQueueRuntimeClient)")
    expect(nitroPlugin).toContain("setQueueRuntimeRegistry(queueRegistry)")
    expect(nitroPlugin).not.toContain("enterQueueRuntimeEvent")
    expect(nitroPlugin).not.toContain("hooks.hook('request'")
    expect(nitroPlugin).not.toContain("cloudflare:workers")
    expect(nitroPlugin).not.toContain("setQueueRuntimeEventDefaults({")
    expect(nitroMiddleware).toContain("defineMiddleware((event) =>")
    expect(nitroMiddleware).not.toContain("cloudflare:workers")
    expect(nitroMiddleware).toContain("const runtimeEvent = event as any")
    expect(nitroMiddleware).toContain("runtimeEvent.node?.req?.runtime?.cloudflare?.env")
    expect(nitroMiddleware).not.toContain("?? vitehubEnv")
    expect(nitroMiddleware).not.toContain("waitUntil: vitehubWaitUntil")
    expect(nitroMiddleware).toContain("enterQueueRuntimeEvent(event)")
    expect(nitroMiddleware).not.toContain("enterQueueRuntimeEvent(runtimeEvent)")
    expect(nitroMiddleware).not.toContain("next")
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

    const addedDefinition = join(root, "follow-up.queue.ts")
    await writeFile(addedDefinition, "export default { handler: async () => undefined }\n")
    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: addedDefinition,
      server: { config: resolved },
    })
    expect(await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).not.toContain("cloudflare:workers")
    expect(await readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")).not.toContain("cloudflare:workers")
  }, 15_000)

  it("keeps Cloudflare globals in generated production runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-production-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    const plugin = hubQueue({ provider: "cloudflare" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "cloudflare_module" },
      plugins: [{ name: "nitro:main" }],
      queue: { provider: "cloudflare" },
      resolve: { alias: [] },
      root,
    } as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    const nitroMiddleware = await readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")
    expect(nitroPlugin).toContain("import * as vitehubCloudflareWorkers from 'cloudflare:workers'")
    expect(nitroPlugin).toContain("const { env: vitehubEnv, waitUntil: vitehubWaitUntil } = vitehubCloudflareWorkers as unknown as")
    expect(nitroPlugin).toContain("setQueueRuntimeEventDefaults({ env: vitehubEnv, waitUntil: vitehubWaitUntil })")
    expect(nitroMiddleware).toContain("import * as vitehubCloudflareWorkers from 'cloudflare:workers'")
    expect(nitroMiddleware).toContain("Object.assign(event, { env: runtimeEvent.env")

    await symlink(join(workspaceRoot, "node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "runtime-types.d.ts"), [
      "declare namespace CloudflareWorkersModule { const __brand: unknown }",
      "declare module 'cloudflare:workers' { export = CloudflareWorkersModule }",
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
      .catch((error: unknown) => {
        const output = Reflect.get(Object(error), "stdout") || Reflect.get(Object(error), "stderr")
        throw new Error(String(output || error))
      })
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
      expect(() => config({ nitro: { preset: "cloudflare_module" }, root })).toThrow(expect.objectContaining({ code: "QUEUE_INVALID_NAME" }))
    }
  })

  it("infers providers for generated Nitro runtime imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({})
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ queue: {}, root, nitro: { preset: "vercel" } } as never)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain("@vercel/queue/dist/index.js")
    expect(nitroPlugin).toContain("internal/runtime/vercel-client")
    expect(nitroPlugin).toContain("internal/runtime/state")
    expect(nitroPlugin).not.toContain("/src/runtime/state")
    expect(nitroPlugin).not.toContain("/dist/runtime/state")
    expect(nitroPlugin).not.toContain("@vite-hub/queue/")
    expect(nitroPlugin).toContain("setQueueRuntimeConfig(queueConfig, createVercelQueueRuntimeClient)")
    expect(nitroPlugin).not.toContain("createCloudflareQueueRuntimeClient")
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
    expect(nitroPlugin).not.toContain("createCloudflareQueueRuntimeClient")
    expect(nitroPlugin).not.toContain("createVercelQueueRuntimeClient")
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

  it("loads the Vercel SDK for direct clients without definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    const plugin = hubQueue({})
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ queue: {}, root, nitro: { preset: "vercel" } } as never)
    const pluginFile = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    const middlewareFile = await readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")
    expect(pluginFile).toContain("@vercel/queue")
    expect(pluginFile).toContain("globalThis.__vitehubVercelQueue =")
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
    await runBuildEnd(plugin)

    const disabled = { nitro: { preset: "cloudflare_module", handlers: [{ handler: ".vitehub/nitro/queue/middleware.ts", middleware: true, route: "/**" }, { handler: "server/middleware.ts", middleware: true }], plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"] }, queue: false, root }
    ;(hubQueue(false).config as unknown as (config: Record<string, unknown>) => void)(disabled)
    expect(disabled.nitro.plugins).toEqual(["server/plugin.ts"])
    expect(disabled.nitro.handlers).toEqual([{ handler: "server/middleware.ts", middleware: true }])
    expect(disabled.nitro).not.toHaveProperty("cloudflare")
  })

  it("registers one Nitro route with a Vercel queue trigger per Queue Definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-vercel-consumers-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    await mkdir(join(root, "emails"), { recursive: true })
    await writeFile(join(root, "emails", "digest.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "vercel" })
    const config = {
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "vercel", vercel: { functionRules: { "/api/heavy": { memory: 3009 } } } },
      plugins: [{ name: "nitro:main" }],
      root,
    }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config as never)
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config as never)

    // SAFETY: hubQueue writes Nitro handler records with string handler paths and routes.
    const handlers = Reflect.get(config.nitro, "handlers") as Array<{ handler: string, route?: string }>
    const consumers = handlers.filter(handler => handler.route?.startsWith("/api/vitehub/queues/vercel/"))
    expect(consumers.map(handler => handler.route).sort()).toEqual(["/api/vitehub/queues/vercel/emails/digest", "/api/vitehub/queues/vercel/welcome"])
    expect(config).toHaveProperty(["nitro", "vercel", "functionRules", "/api/heavy"], { memory: 3009 })
    expect(config).toHaveProperty(["nitro", "vercel", "functionRules", "/api/vitehub/queues/vercel/welcome"], {
      experimentalTriggers: [{
        consumer: "api_Svitehub_Squeues_Svercel_Swelcome_Dfunc",
        topic: "topic--77656c636f6d65",
        type: "queue/v2beta",
      }],
    })
    for (const consumer of consumers) {
      const handler = await readFile(consumer.handler, "utf8")
      expect(handler).toContain("handleHostedVercelQueueCallback(event, name, definition)")
    }
  })

  it.each([
    { preset: "node", vercel: undefined },
    { preset: undefined, vercel: undefined },
    { preset: undefined, vercel: "1" },
  ])("registers Vercel queue consumers only for a Vercel host (preset $preset, VERCEL $vercel)", async ({ preset, vercel }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-vercel-host-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    vi.stubEnv("VERCEL", vercel)
    try {
      const config = { nitro: preset ? { preset } : {}, root }
      ;(hubQueue({ provider: "vercel" }).config as unknown as (config: Record<string, unknown>) => void)(config)
      if (vercel) expect(config).toHaveProperty(["nitro", "vercel", "functionRules", "/api/vitehub/queues/vercel/welcome"])
      else expect(config.nitro).not.toHaveProperty("vercel")
    }
    finally {
      vi.unstubAllEnvs()
    }
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

    await expect(runBuildEnd(plugin)).rejects.toMatchObject({ code: "QUEUE_DEFINITIONS_CHANGED" })
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

    await expect(runBuildEnd(plugin)).rejects.toMatchObject({ code: "QUEUE_DEFINITIONS_CHANGED" })
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

    await expect(runBuildEnd(plugin)).rejects.toMatchObject({ code: "QUEUE_DEFINITIONS_CHANGED" })
  })

  it("rejects ambiguous and conflicting custom Cloudflare bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "first.queue.ts"), "export default { handler: async () => undefined }\n")
    await writeFile(join(root, "second.queue.ts"), "export default { handler: async () => undefined }\n")
    const custom = hubQueue({ provider: "cloudflare", binding: "JOBS" }).config as unknown as (config: Record<string, unknown>) => unknown
    expect(() => custom({ nitro: { preset: "cloudflare_module" }, root })).toThrow(expect.objectContaining({ code: "QUEUE_BINDING_CONFLICT" }))

    await rm(join(root, "second.queue.ts"))
    const generatedBinding = "QUEUE_6669727374"
    const config = hubQueue({ provider: "cloudflare" }).config as unknown as (config: Record<string, unknown>) => unknown
    expect(() => config({ nitro: { preset: "cloudflare_module", cloudflare: { wrangler: { queues: { producers: [{ binding: generatedBinding, queue: "other" }] } } } }, root })).toThrow(/already assigned/)
  })
})
