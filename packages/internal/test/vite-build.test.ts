import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { mergeConfig, resolveConfig } from "vite"

import {
  createNoExternalMerger,
  createNoExternalAddition,
  createProviderOutputEnvironmentOwner,
  generatedViteHubWatchIgnoredAddition,
  hasNitroConfigContext,
  loadsViteHubPackagesNatively,
  renderNativePackageInstallPlugin,
  resolveNitroVercelFunctionName,
  resolveNuxtServerDirs,
  resolveViteHubGeneratedRoot,
  resolveViteHubProjectRoot,
  VITEHUB_GENERATED_ROOT,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  workerdDependencyConfig,
} from "../src/build/vite.ts"

describe("Vite provider builds", () => {
  it.each([undefined, true, false])("preserves app dependency options with noDiscovery: %s", async (noDiscovery) => {
    const config = await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: [{ name: "integration", configEnvironment: { order: "post", handler: workerdDependencyConfig } }],
      environments: { nitro: {
        consumer: "server",
        resolve: { noExternal: true, conditions: ["worker"] },
        optimizeDeps: { noDiscovery, include: ["app-included"], exclude: ["app-excluded"] },
      } },
    }, "serve")

    expect(config.environments.nitro!.optimizeDeps).toMatchObject({
      noDiscovery: noDiscovery ?? false,
      include: ["app-included"],
      exclude: ["app-excluded", "nitro"],
    })
  })

  it.each([
    { label: "Nitro RC defaults", command: "serve", consumer: "server", noExternal: [/^nitro(\/|$)/], conditions: ["workerd"] },
    { label: "Node", command: "serve", consumer: "server", noExternal: true, conditions: ["node"] },
    { label: "build", command: "build", consumer: "server", noExternal: true, conditions: ["workerd"] },
    { label: "client", command: "serve", consumer: "client", noExternal: true, conditions: ["worker"] },
  ] as const)("leaves $label dependency optimization alone", async ({ command, consumer, noExternal, conditions }) => {
    const config = await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: [{ name: "integration", configEnvironment: { order: "post", handler: workerdDependencyConfig } }],
      environments: { custom: {
        consumer,
        resolve: { noExternal: noExternal === true ? true : [...noExternal], conditions: [...conditions] },
        optimizeDeps: { noDiscovery: true },
      } },
    }, command)

    expect(config.environments.custom!.optimizeDeps.noDiscovery).toBe(true)
    expect(config.environments.custom!.optimizeDeps.exclude ?? []).not.toContain("nitro")
  })

  it("loads ViteHub packages natively only in the Nitro environment of vite dev", () => {
    expect(loadsViteHubPackagesNatively("nitro", { command: "serve" })).toBe(true)
    expect(loadsViteHubPackagesNatively("nitro", { command: "build" })).toBe(false)
    expect(loadsViteHubPackagesNatively("ssr", { command: "serve" })).toBe(false)
  })

  it("renders a Nitro plugin that hands each generated module to its package", async () => {
    const source = renderNativePackageInstallPlugin([
      { from: "@vite-hub/agent/server/registry", install: "installAgentRegistry", module: "./registry.mjs" },
      { from: "@vite-hub/agent/server/registry", install: "installAgentKV", module: "vite-hub/_internal/kv" },
      { from: "@vite-hub/agent/server/registry", install: "installAgentServerEnv" },
    ])
    expect(source).toBe([
      'import { installAgentRegistry as viteHubInstall0 } from "@vite-hub/agent/server/registry"',
      'import * as viteHubModule0 from "./registry.mjs"',
      'import { installAgentKV as viteHubInstall1 } from "@vite-hub/agent/server/registry"',
      'import * as viteHubModule1 from "vite-hub/_internal/kv"',
      'import { installAgentServerEnv as viteHubInstall2 } from "@vite-hub/agent/server/registry"',
      "",
      "viteHubInstall0(viteHubModule0)",
      "viteHubInstall1(viteHubModule1)",
      "viteHubInstall2(undefined)",
      "",
      "export default function viteHubNativePackagesPlugin() {}",
      "",
    ].join("\n"))
  })

  it("merges a package into existing noExternal values", () => {
    const merge = createNoExternalMerger("@vite-hub/blob")
    expect(merge(undefined)).toEqual(["@vite-hub/blob"])
    expect(merge("existing")).toEqual(["existing", "@vite-hub/blob"])
    expect(merge(["existing", "@vite-hub/blob"])).toEqual(["existing", "@vite-hub/blob"])
    expect(merge(true)).toBe(true)
  })

  it("preserves scalar and array noExternal entries across plugin config merges", () => {
    const existingPattern = /existing/
    for (const noExternal of [undefined, "existing", existingPattern, ["existing", existingPattern]]) {
      let config = { ssr: { noExternal } }
      for (const packageName of ["@vite-hub/auth", "@vite-hub/workspace", "@vite-hub/auth"]) {
        config = mergeConfig(config, { ssr: { noExternal: createNoExternalAddition(packageName)(config.ssr.noExternal) } })
      }
      expect(config.ssr.noExternal).toEqual([
        ...(noExternal === undefined ? [] : Array.isArray(noExternal) ? noExternal : [noExternal]),
        "@vite-hub/auth",
        "@vite-hub/workspace",
      ])
    }
    expect(mergeConfig({ ssr: { noExternal: true } }, {
      ssr: { noExternal: createNoExternalAddition("@vite-hub/auth")(true) },
    }).ssr.noExternal).toBe(true)
  })

  it("preserves scalar watch matchers and adds the generated ignore only once", () => {
    const existingPattern = /existing/
    const existingPredicate = (path: string) => path.includes("existing")
    for (const ignored of [undefined, "**/existing/**", existingPattern, existingPredicate, ["**/existing/**", existingPattern, existingPredicate]]) {
      let config = { server: { watch: { ignored } } }
      for (let plugin = 0; plugin < 3; plugin++) {
        config = mergeConfig(config, { server: { watch: { ignored: generatedViteHubWatchIgnoredAddition(config.server.watch.ignored) } } })
      }
      expect(config.server.watch.ignored).toEqual([
        ...(ignored === undefined ? [] : Array.isArray(ignored) ? ignored : [ignored]),
        "**/.vitehub/**",
      ])
    }
  })

  it("continues project discovery above a repository-local temporary directory", async () => {
    const previousTemporaryDirectories = {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
    }
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-project-root-boundary-"))
    const temporaryRoot = join(projectRoot, ".tmp")
    const nestedRoot = join(temporaryRoot, "fixture")
    try {
      await mkdir(nestedRoot, { recursive: true })
      await writeFile(join(projectRoot, "package.json"), '{"private":true}\n')
      process.env.TEMP = temporaryRoot
      process.env.TMP = temporaryRoot
      process.env.TMPDIR = temporaryRoot

      expect(resolveViteHubProjectRoot(nestedRoot)).toBe(projectRoot)
      expect(resolveViteHubProjectRoot(nestedRoot, { projectRoot })).toBe(projectRoot)
    }
    finally {
      for (const [name, value] of Object.entries(previousTemporaryDirectories)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("keeps ordinary app packages at their nearest project marker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-app-project-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await Promise.all([
        writeFile(join(projectRoot, "package.json"), '{"private":true}\n'),
        writeFile(join(appRoot, "package.json"), '{"private":true}\n'),
      ])

      expect(resolveViteHubProjectRoot(appRoot)).toBe(appRoot)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("prefers a parent with ViteHub directories for app roots", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-app-parent-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await Promise.all([
        mkdir(join(projectRoot, "server", "agents"), { recursive: true }),
        writeFile(join(appRoot, "package.json"), '{"private":true}\n'),
      ])

      expect(resolveViteHubProjectRoot(appRoot)).toBe(projectRoot)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("prefers a Nuxt project root when app has its own package marker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-nuxt-app-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await Promise.all([
        writeFile(join(projectRoot, "package.json"), '{"private":true}\n'),
        writeFile(join(projectRoot, "nuxt.config.ts"), "export default {}\n"),
        writeFile(join(appRoot, "package.json"), '{"private":true}\n'),
      ])

      expect(resolveViteHubProjectRoot(appRoot)).toBe(projectRoot)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("resolves generated artifacts at the project root for nested Vite apps", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-generated-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await writeFile(join(projectRoot, "package.json"), '{"private":true}\n')

      expect(resolveViteHubGeneratedRoot({ root: appRoot })).toBe(join(projectRoot, ".vitehub"))
      expect(resolveViteHubGeneratedRoot({
        [VITEHUB_GENERATED_ROOT]: join(projectRoot, ".nuxt/vitehub"),
        root: appRoot,
      })).toBe(join(projectRoot, ".nuxt/vitehub"))
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("distinguishes the Nitro host plugin from ViteHub bridge plugins", () => {
    expect(hasNitroConfigContext({ plugins: [{ name: "nitro:main" }] })).toBe(true)
    expect(hasNitroConfigContext({ plugins: [[false, [{ name: "nitro:main" }]]] })).toBe(true)
    expect(hasNitroConfigContext({ [VITEHUB_NITRO_CONFIG_CONTEXT]: true })).toBe(true)
    expect(hasNitroConfigContext({ plugins: [{ name: "@vite-hub/blob/vite" }, { name: "@vite-hub/queue/vite" }] })).toBe(false)
    expect(hasNitroConfigContext({ plugins: [[{ name: "@vite-hub/blob/vite" }]] })).toBe(false)
  })

  it("writes Provider Output only in the Nitro environment when Nitro builds it last", async () => {
    const client = { isBuilt: false }
    const nitro = { isBuilt: false }
    const owner = createProviderOutputEnvironmentOwner("test")
    owner.nitro.setup({ options: { static: false } })
    await owner.buildApp({ environments: { client, nitro } })

    expect(owner.defers({ environment: client })).toBe(true)
    expect(owner.defers({ environment: nitro })).toBe(false)
    expect(owner.defers(undefined)).toBe(false)
    nitro.isBuilt = true
    expect(owner.defers({ environment: client })).toBe(false)
  })

  it("writes Provider Output in the client environment without a later Nitro build", async () => {
    const client = { isBuilt: false }
    const nitro = { isBuilt: false }
    const withoutBuildApp = createProviderOutputEnvironmentOwner("test")
    withoutBuildApp.nitro.setup({ options: { static: false } })
    const staticNitro = createProviderOutputEnvironmentOwner("test")
    staticNitro.nitro.setup({ options: { static: true } })
    await staticNitro.buildApp({ environments: { client, nitro } })
    const withoutNitro = createProviderOutputEnvironmentOwner("test")
    await withoutNitro.buildApp({ environments: { client } })

    expect(withoutBuildApp.defers({ environment: client })).toBe(false)
    expect(staticNitro.defers({ environment: client })).toBe(false)
    expect(withoutNitro.defers({ environment: client })).toBe(false)
  })

  it("isolates provider functions when Nitro owns the Vercel output", () => {
    const plugins = [{ name: "vitehub" }, { name: "nitro:main" }]

    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "vercel" } }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "vercel-edge" } }, "database", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName({ plugins }, "queue", { VERCEL: "1" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName({ plugins }, "workflow", { VITEHUB_HOSTING: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName({ nitro: { preset: "vercel" }, plugins: [{ name: "vitehub" }] }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ nitro: { preset: "vercel-edge" } }, "database", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName({}, "workflow", { NITRO_PRESET: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName({}, "queue", { SERVER_PRESET: "vercel-edge" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName({
      environments: { client: { build: { outDir: ".vercel/output/static" } } },
      plugins,
    }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ plugins: [{ name: "vitehub" }] }, "blob", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({}, "blob", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "node-server" } }, "blob", {})).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "node-server" } }, "blob", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "cloudflare" } }, "blob", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
  })
})

describe("resolveNuxtServerDirs", () => {
  it("lists the application server directory first, then each layer in Nuxt priority order", () => {
    expect(resolveNuxtServerDirs({
      _layers: [
        { config: { rootDir: "/app", serverDir: "/app/server", srcDir: "/app/app" }, cwd: "/app" },
        { config: { rootDir: "/layers/auth", serverDir: "/layers/auth/server", srcDir: "/layers/auth/app" }, cwd: "/layers/auth" },
        { config: { rootDir: "/layers/blog", serverDir: "backend", srcDir: "/layers/blog" }, cwd: "/layers/blog" },
        { config: { rootDir: "/layers/auth", serverDir: "/layers/auth/server" }, cwd: "/layers/auth" },
      ],
      rootDir: "/app",
      serverDir: "/app/custom-server",
    })).toEqual(["/app/custom-server", "/layers/auth/server", "/layers/blog/backend"])
  })

  it("keeps a single server directory without layers", () => {
    expect(resolveNuxtServerDirs({ rootDir: "/app", serverDir: "/app/server" })).toEqual(["/app/server"])
    expect(resolveNuxtServerDirs({ rootDir: "/app" })).toBeUndefined()
  })

  it("keeps the application first when Nuxt omits its server directory", () => {
    expect(resolveNuxtServerDirs({
      _layers: [{ config: { rootDir: "/layers/auth" }, cwd: "/layers/auth" }],
      rootDir: "/app",
    })).toEqual(["/app/server", "/layers/auth/server"])
  })
})
