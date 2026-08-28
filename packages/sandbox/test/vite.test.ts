import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"
import { build, type AliasOptions } from "vite"

const tempDirs: string[] = []
const runtimePreparationMock = vi.hoisted(() => ({
  // SAFETY: The test hook assigns this callback only after the hoisted mock has been initialized.
  afterPrepare: undefined as (() => Promise<void>) | undefined,
  // SAFETY: The test hook assigns this callback only after the hoisted mock has been initialized.
  beforePrepare: undefined as (() => Promise<void>) | undefined,
}))

vi.mock("../src/internal/runtime-preparation.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/internal/runtime-preparation.ts")>()
  return {
    ...original,
    async prepareSandboxRuntime(...args: Parameters<typeof original.prepareSandboxRuntime>) {
      await runtimePreparationMock.beforePrepare?.()
      const prepared = await original.prepareSandboxRuntime(...args)
      await runtimePreparationMock.afterPrepare?.()
      return prepared
    },
  }
})

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function readAlias(alias: AliasOptions | undefined, id: string) {
  if (Array.isArray(alias)) {
    return alias.find((entry) => {
      if (typeof entry.find === "string") return entry.find === id
      return entry.find.test(id)
    })?.replacement
  }

  return (alias as Record<string, string> | undefined)?.[id]
}

type SandboxNitroPlugin = {
  nitro: {
    setup: (nitro: {
      hooks: { hook: (name: "build:before", callback: () => void) => void }
      options: Record<string, unknown>
    }) => void
  }
}

function createSandboxNitroLifecycle(
  plugin: SandboxNitroPlugin,
  initial: Array<string | RegExp> = [],
) {
  const options: Record<string, unknown> = { noExternals: initial }
  let buildBefore: (() => void) | undefined
  plugin.nitro.setup({
    hooks: {
      hook(name, callback) {
        expect(name).toBe("build:before")
        buildBefore = callback
      },
    },
    options,
  })
  return () => {
    expect(buildBefore).toBeTypeOf("function")
    buildBefore!()
    return options
  }
}

function readSandboxNitroNoExternals(
  plugin: SandboxNitroPlugin,
  initial: Array<string | RegExp> = [],
) {
  return createSandboxNitroLifecycle(plugin, initial)().noExternals as Array<string | RegExp>
}

async function createViteRoot(parentDir = tmpdir()) {
  const rootDir = await mkdtemp(join(parentDir, "vitehub-sandbox-vite-"))
  tempDirs.push(rootDir)
  await writeFile(join(rootDir, "package.json"), JSON.stringify({
    name: "vitehub-sandbox-vite-fixture",
    private: true,
    type: "module",
  }, null, 2))
  await mkdir(join(rootDir, "src/tools"), { recursive: true })
  await writeFile(join(rootDir, "src/tools/release-notes.sandbox.ts"), [
    `import { defineSandbox } from "@vite-hub/sandbox"`,
    ``,
    `export default defineSandbox({ run: async () => ({ ok: true }) })`,
    ``,
  ].join("\n"))
  return rootDir
}

afterEach(async () => {
  runtimePreparationMock.afterPrepare = undefined
  runtimePreparationMock.beforePrepare = undefined
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("hubSandbox", () => {
  it("exposes Vite Sandbox state", async () => {
    const rootDir = await createViteRoot(process.cwd())
    const { hubSandbox } = await import("../src/vite.ts")
    const providerImportAliases: Record<string, string> = {}
    const plugin = hubSandbox({
      provider: "vercel",
      providerImportAliases,
      providerImportSpecifier: "vite-hub/sandbox",
    } as never)
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    const configResult = await configHook({
      root: rootDir,
      sandbox: {
        provider: "vercel",
      },
    }, {
      command: "serve",
      mode: "development",
    })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const resolvedId = await resolveId("#vitehub/sandbox")
    const code = await load(resolvedId as string)

    expect(code).toContain('"provider": "vercel"')
    const alias = (configResult as { resolve: { alias: AliasOptions } }).resolve.alias
    const registryAlias = readAlias(alias, "#vitehub-sandbox-registry")!
    const providerLoaderAlias = readAlias(alias, "vitehub-sandbox-provider-loader")!
    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server" }) => unknown
    const serverConfig = configEnvironment("ssr", { consumer: "server" }) as { resolve: { alias: AliasOptions } }
    const sandboxAlias = readAlias(serverConfig.resolve.alias, "@vite-hub/sandbox")!

    expect(readAlias(alias, "@vite-hub/sandbox")).toBeUndefined()
    expect(sandboxAlias).toContain(".vitehub/sandbox/runtime/sandbox.mjs")
    expect(providerImportAliases["@vite-hub/sandbox"]).toMatch(/packages\/sandbox\/(?:src|dist)$/)
    expect(providerImportAliases["vite-hub/sandbox"]).toBe(sandboxAlias)
    expect(providerImportAliases["vitehub-sandbox-provider-loader"]).toBe(providerLoaderAlias)

    await configHook({ root: rootDir, sandbox: false }, { command: "serve", mode: "development" })
    await configResolved({ root: rootDir, resolve: { alias: [] } })
    expect(providerImportAliases).not.toHaveProperty("@vite-hub/sandbox")
    expect(providerImportAliases).not.toHaveProperty("vite-hub/sandbox")
    expect(providerImportAliases).not.toHaveProperty("vitehub-sandbox-provider-loader")
    expect(registryAlias).toContain(".vitehub/sandbox/runtime/sandbox-registry.mjs")
    expect(providerLoaderAlias).toContain(".vitehub/sandbox/runtime/sandbox-provider-loader.mjs")
    expect(readAlias(alias, "@vite-hub/sandbox/runtime/state")).toBeUndefined()
    expect(readAlias(alias, "@vite-hub/sandbox/runtime/provider-loader")).toContain(".vitehub/sandbox/runtime/sandbox-provider-loader.mjs")

    const [facade, registry, providerLoader] = await Promise.all([
      readFile(sandboxAlias, "utf8"),
      readFile(registryAlias, "utf8"),
      readFile(providerLoaderAlias, "utf8"),
    ])
    expect(facade).toContain("setSandboxRuntimeConfig")
    expect(facade).toContain("setSandboxRuntimeRegistry(sandboxRegistry)")
    expect(facade).toContain("export * from")
    expect(facade).not.toContain("providerImportAliases")
    expect(facade).not.toContain("@vite-hub/kv/runtime/upstash-driver")
    const facadePackageImports = [
      facade.match(/import \{ setSandboxRuntimeConfig, setSandboxRuntimeRegistry \} from "([^"]+)"/)?.[1],
      facade.match(/export \* from "([^"]+)"/)?.[1],
    ].filter((specifier): specifier is string => Boolean(specifier))
    expect(facadePackageImports).toHaveLength(2)
    await Promise.all(facadePackageImports.map(async (specifier) => {
      await expect(realpath(join(dirname(sandboxAlias), specifier))).resolves.toMatch(/packages\/sandbox\/(?:src|dist)/)
    }))
    expect(registry).toContain('"tools/release-notes"')
    expect(providerLoader).toContain("resolveSandboxBox")
    expect(providerLoader).not.toContain("createSandboxClient")
    expect(providerLoader).not.toContain("import('./providers/vercel.js')")
    await expect(readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox.d.ts"), "utf8")).resolves.toContain('"tools/release-notes"')
  })

  it("loads only the selected generated Definition payload", async () => {
    const rootDir = await createViteRoot()
    await writeFile(join(rootDir, "src/tools/unrelated.sandbox.ts"), [
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      `export default defineSandbox({ run: async () => ({ unrelated: true }) })`,
      ``,
    ].join("\n"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({ root: rootDir }, { command: "serve", mode: "development" })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const registryFile = await realpath(join(rootDir, ".vitehub/sandbox/runtime/sandbox-registry.mjs"))
    const unrelatedFile = await realpath(join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__unrelated.mjs"))
    const unrelatedContents = await readFile(unrelatedFile, "utf8")
    const loadedMarker = "__vitehubSandboxUnrelatedDefinitionLoaded"
    Reflect.deleteProperty(globalThis, loadedMarker)
    await writeFile(unrelatedFile, [
      `globalThis.${loadedMarker} = true`,
      unrelatedContents,
    ].join("\n"))

    const registryModule: { default: Record<string, () => Promise<unknown>> } = await import(pathToFileURL(registryFile).href)
    expect(Reflect.get(globalThis, loadedMarker)).toBeUndefined()
    await expect(registryModule.default["tools/release-notes"]?.()).resolves.toBeDefined()
    expect(Reflect.get(globalThis, loadedMarker)).toBeUndefined()
    await expect(registryModule.default["tools/unrelated"]?.()).resolves.toBeDefined()
    expect(Reflect.get(globalThis, loadedMarker)).toBe(true)
    Reflect.deleteProperty(globalThis, loadedMarker)
  })

  it("accepts direct integration options", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    await configHook({
      root: rootDir,
    }, {
      command: "serve",
      mode: "development",
    })

    const resolvedId = await resolveId("#vitehub/sandbox")
    const code = await load(resolvedId as string)

    expect(code).toContain('"provider": "vercel"')
  })

  it("keeps project definitions when Nuxt owns a custom nested Vite root", async () => {
    const rootDir = await createViteRoot()
    const appDir = join(rootDir, "src/client")
    await mkdir(appDir, { recursive: true })
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>

    await configHook({ root: rootDir, __vitehubProjectRoot: rootDir }, { command: "build", mode: "production" })
    await configResolved({ root: appDir, resolve: { alias: [] } })

    await expect(readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox-registry.mjs"), "utf8"))
      .resolves.toContain('"tools/release-notes"')
  })

  it("does not discover conflicting Definitions when Sandbox is disabled", async () => {
    const rootDir = await createViteRoot()
    await mkdir(join(rootDir, "server/sandboxes/tools/release-notes"), { recursive: true })
    await writeFile(join(rootDir, "server/sandboxes/tools/release-notes/index.ts"), [
      `export default async function run() { return { ok: true } }`,
      ``,
    ].join("\n"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox(false)
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>

    await expect(configHook({ root: rootDir }, { command: "build", mode: "production" })).resolves.toBeDefined()
  })

  it("keeps default Sandbox inert when the Vite root has no package manifest", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-sandbox-vite-"))
    tempDirs.push(rootDir)
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox()
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>

    await expect(configHook({ root: rootDir }, { command: "build", mode: "production" })).resolves.toBeDefined()
  })

  it("exposes hosting inference and normalized runtime config through sandbox state", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox()
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    await configHook({ root: rootDir, preset: "vercel" }, { command: "serve", mode: "development" })

    const resolvedId = await resolveId("#vitehub/sandbox")
    const code = await load(resolvedId as string)

    expect(code).toContain('"hosting": "vercel"')
    expect(code).toContain('"provider": "vercel"')
    expect(code).toContain('"token": ""')
    expect(code).toContain('"teamId": ""')
    expect(code).toContain('"projectId": ""')
  })

  it("bundles generated definitions with auto-imports and Vite aliases", async () => {
    const rootDir = await createViteRoot()
    await mkdir(join(rootDir, "src/lib"), { recursive: true })
    await writeFile(join(rootDir, "src/lib/message.ts"), `export const message = "from alias"\n`)
    await writeFile(join(rootDir, "src/tools/release-notes.sandbox.ts"), [
      `import { message } from "@/lib/message"`,
      ``,
      `export default defineSandbox({ run: async () => ({ message }) })`,
      ``,
    ].join("\n"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: AliasOptions } }) => unknown | Promise<unknown>

    await configHook({
      root: rootDir,
      resolve: {
        alias: {
          "@": join(rootDir, "src"),
        },
      },
    }, {
      command: "serve",
      mode: "development",
    })
    await configResolved({
      root: rootDir,
      resolve: {
        alias: [
          {
            find: "@",
            replacement: join(rootDir, "src"),
          },
        ],
      },
    })

    await expect(readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs"), "utf8")).resolves.toContain("from alias")
  })

  it("preserves the nearest package project for a Definition", async () => {
    const rootDir = await createViteRoot()
    await mkdir(join(rootDir, "node_modules/kleur"), { recursive: true })
    await writeFile(join(rootDir, "node_modules/kleur/package.json"), JSON.stringify({
      exports: "./index.js",
      name: "kleur",
      type: "module",
    }))
    await writeFile(join(rootDir, "node_modules/kleur/index.js"), `export default { green: value => \`green:\${value}\` }\n`)
    await writeFile(join(rootDir, "package.json"), JSON.stringify({
      dependencies: { kleur: "^4.1.5" },
      packageManager: "pnpm@10.33.0",
      private: true,
      type: "module",
    }, null, 2))
    await writeFile(join(rootDir, "src/tools/release-notes.sandbox.ts"), [
      `import kleur from "kleur"`,
      `export default defineSandbox({ run: async () => ({ message: kleur.green("ready") }) })`,
    ].join("\n"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: AliasOptions } }) => unknown | Promise<unknown>

    await configHook({ root: rootDir }, { command: "build", mode: "production" })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const generated = await readFile(
      join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs"),
      "utf8",
    )
    const artifact = JSON.parse(generated.slice("export default ".length))
    expect(artifact.bundle.modules[artifact.bundle.entry]).toContain("ready")
    expect(artifact.bundle.modules[artifact.bundle.entry]).toContain('from "kleur"')
    expect(artifact.bundle.project.packagePath).toBe(".")
    expect(artifact.bundle.project.install.command).toBe("pnpm")
  })

  it("keeps Node built-ins out of definition bundle aliases", async () => {
    const rootDir = await createViteRoot()
    await mkdir(join(rootDir, "src/lib"), { recursive: true })
    await writeFile(join(rootDir, "src/lib/version.ts"), `export const version = "from slash alias"\n`)
    await writeFile(join(rootDir, "src/lib/process.ts"), `export const processAlias = "from process slash alias"\n`)
    await writeFile(join(rootDir, "src/tools/release-notes.sandbox.ts"), [
      `import { execFileSync } from "node:child_process"`,
      `import { version } from "@/lib/version"`,
      `import { processAlias } from "process/"`,
      ``,
      `export default defineSandbox({ run: async () => ({ processAlias, version, node: execFileSync(process.execPath, ["--version"]).toString() }) })`,
      ``,
    ].join("\n"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: AliasOptions } }) => unknown | Promise<unknown>

    await configHook({ root: rootDir }, { command: "build", mode: "production" })
    await configResolved({
      root: rootDir,
      resolve: {
        alias: [
          { find: "process/", replacement: join(rootDir, "src/lib/process.ts") },
          { find: "node:child_process", replacement: "/virtual/child-process" },
          { find: "#root/", replacement: "/" },
          { find: "@/", replacement: `${join(rootDir, "src")}/` },
        ],
      },
    })

    const definition = await readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs"), "utf8")
    expect(definition).toContain("node:child_process")
    expect(definition).not.toContain("/virtual/child-process")
    expect(definition).toContain("from slash alias")
    expect(definition).not.toContain("from process slash alias")
  })

  it("builds an executable package entry for a Cloudflare Nitro host", async () => {
    const rootDir = await createViteRoot()
    await rm(join(rootDir, "src/tools/release-notes.sandbox.ts"))
    const packageRoot = join(rootDir, "server/sandboxes/example")
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(rootDir, "src/server.ts"), `export const ready = true\n`)
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      private: true,
      type: "module",
      vitehub: { sandbox: { timeout: 30_000 } },
    }))
    await writeFile(join(packageRoot, "helper.ts"), `export const ok = true\n`)
    await writeFile(join(packageRoot, "index.ts"), [
      `import { ok } from "./helper.ts"`,
      `export default async function run(payload: { value: string }) {`,
      `  await Promise.resolve()`,
      `  return { ok, value: payload.value }`,
      `}`,
      ``,
    ].join("\n"))
    const { hubSandbox } = await import("../src/vite.ts")
    let resolvedNitro: any

    await build({
      appType: "custom",
      build: {
        rollupOptions: { input: join(rootDir, "src/server.ts") },
        write: false,
      },
      nitro: { preset: "cloudflare-module" } as Record<string, any>,
      plugins: [
        hubSandbox(),
        {
          name: "nitro:main",
          configResolved(config: { nitro?: unknown }) {
            resolvedNitro = config.nitro
          },
        },
      ],
      root: rootDir,
    } as never)

    expect(resolvedNitro.cloudflare.wrangler.containers).toMatchObject([{ class_name: "Sandbox" }])
    await expect(readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox-registry.mjs"), "utf8")).resolves.toContain('"example"')
    await expect(readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox-provider-loader.mjs"), "utf8")).resolves.toContain("resolveSandboxBox")
    const generatedDefinition = await readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/example.mjs"), "utf8")
    expect(JSON.parse(generatedDefinition.slice("export default ".length))).toMatchObject({
      bundle: {
        execution: "module",
        project: {
          files: { "package.json": expect.any(Object) },
          install: { command: "npm" },
        },
      },
      options: { timeout: 30_000 },
    })
    const generatedTypes = await readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox.d.ts"), "utf8")
    expect(generatedTypes).toContain("SandboxPackageContract<typeof import(")
    expect(generatedTypes).toContain("TArgs extends [] ? unknown : TArgs[0]")
  })

  it("keeps Cloudflare output inert without Sandbox definitions", async () => {
    const rootDir = await createViteRoot()
    await rm(join(rootDir, "src/tools/release-notes.sandbox.ts"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox()
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: Record<string, any>) => unknown | Promise<unknown>
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>
    const userConfig = {
      root: rootDir,
      nitro: { preset: "cloudflare-module" } as Record<string, any>,
      plugins: [{ name: "nitro:main" }],
    }

    await configHook(userConfig, { command: "build", mode: "production" })
    await configResolved({ ...userConfig, resolve: { alias: [] } })

    expect(userConfig.nitro).toMatchObject({ preset: "cloudflare-module" })
    const stateId = await resolveId("#vitehub/sandbox")
    expect(await load(stateId as string)).toContain('"sandbox": false')
    await expect(readFile(join(rootDir, ".vitehub/sandbox/Dockerfile"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps unsupported hosting inert without Sandbox definitions", async () => {
    const rootDir = await createViteRoot()
    await rm(join(rootDir, "src/tools/release-notes.sandbox.ts"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox()
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>

    await expect(configHook({
      root: rootDir,
      nitro: { preset: "netlify" },
    }, { command: "build", mode: "production" })).resolves.toBeDefined()
  })

  it("infers Cloudflare from the Nitro preset environment", async () => {
    const rootDir = await createViteRoot()
    const previousPreset = process.env.NITRO_PRESET
    process.env.NITRO_PRESET = "cloudflare-module"
    try {
      const { hubSandbox } = await import("../src/vite.ts")
      const plugin = hubSandbox()
      const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
      const userConfig = { root: rootDir, plugins: [{ name: "nitro:main" }], nitro: {} as Record<string, any> }

      await configHook(userConfig, { command: "build", mode: "production" })

      expect(userConfig.nitro.cloudflare.wrangler.containers).toMatchObject([{ class_name: "Sandbox" }])
    }
    finally {
      if (typeof previousPreset === "undefined") delete process.env.NITRO_PRESET
      else process.env.NITRO_PRESET = previousPreset
    }
  })

  it("composes Cloudflare Sandbox into Nitro output", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({
      provider: "cloudflare",
      name: "image-optimizer",
    })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: Record<string, any>) => unknown | Promise<unknown>
    const existingPlugin = { name: "application-plugin" }
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: {
        preset: "cloudflare-module",
        cloudflare: {
          wrangler: {
            compatibility_flags: ["custom"],
            migrations: [{ tag: "existing", new_sqlite_classes: ["Existing"] }],
            routes: ["example.com/*"],
          },
        },
        output: {
          serverDir: ".nitro/server/output",
        },
        rollupConfig: { external: "application-runtime", plugins: existingPlugin },
      },
    }

    await configHook(userConfig, { command: "build", mode: "production" })
    expect((userConfig.nitro.cloudflare.wrangler as any).containers[0].image).toBe("../../../.vitehub/sandbox/Dockerfile")
    userConfig.nitro.output.serverDir = ".nitro/server/final/output"
    await configResolved({ ...userConfig, resolve: { alias: [] } })

    expect(userConfig.nitro.cloudflare.wrangler).toMatchObject({
      compatibility_flags: ["custom", "nodejs_compat"],
      containers: [{
        class_name: "Sandbox",
        image: "../../../../.vitehub/sandbox/Dockerfile",
        image_build_context: "../../../..",
        instance_type: "lite",
        max_instances: 12,
        name: "image-optimizer",
      }],
      durable_objects: {
        bindings: [{ name: "SANDBOX", class_name: "Sandbox" }],
      },
      migrations: [
        { tag: "existing", new_sqlite_classes: ["Existing"] },
        { tag: "v1", new_sqlite_classes: ["Sandbox"] },
      ],
      routes: ["example.com/*"],
    })
    await expect(readFile(join(rootDir, ".vitehub/sandbox/Dockerfile"), "utf8"))
      .resolves.toMatch(/^FROM docker\.io\/cloudflare\/sandbox:\d[\s\S]*corepack@0\.34\.5[\s\S]*corepack enable pnpm yarn/)

    const configuredNitro = userConfig.nitro as typeof userConfig.nitro & {
      rollupConfig: {
        external: unknown
        plugins: Array<{
          load: (id: string) => string
          name: string
          renderChunk: (code: string, chunk: { exports: string[], fileName: string, isEntry: boolean }) => { code: string }
        }>
      }
    }
    expect(configuredNitro.rollupConfig.plugins[0]).toBe(existingPlugin)
    expect(configuredNitro.rollupConfig.external).toEqual(["application-runtime", "cloudflare:workers"])
    const rollupPlugin = configuredNitro.rollupConfig.plugins[1]
    expect(rollupPlugin.name).toBe("vitehub-sandbox-cloudflare-exports:Sandbox")
    expect(rollupPlugin.load("\0virtual:vitehub-sandbox-cloudflare-exports"))
      .toContain("export class Sandbox extends CloudflareSandbox")
    expect(rollupPlugin.load("\0virtual:vitehub-sandbox-cloudflare-exports"))
      .toContain("export { ContainerProxy } from '@cloudflare/sandbox'")
    expect(rollupPlugin.renderChunk("export default {}", { exports: ["default"], isEntry: true, fileName: "server.js" }).code)
      .toContain(`export { Sandbox, ContainerProxy } from "./sandbox-cloudflare-exports.mjs"`)
    expect(rollupPlugin.renderChunk("export default {}", { exports: ["default"], isEntry: true, fileName: "entries/server.js" }).code)
      .toContain(`export { Sandbox, ContainerProxy } from "../sandbox-cloudflare-exports.mjs"`)
  })

  it("preserves an application-owned Cloudflare Sandbox container", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare", name: "generated-name" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: Record<string, any>) => unknown | Promise<unknown>
    const container = {
      class_name: "Sandbox",
      image: "./custom.Dockerfile",
      instance_type: "standard-1",
      max_instances: 2,
      name: "application-owned",
    }
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: {
        preset: "cloudflare-module",
        cloudflare: { wrangler: { containers: [container] } },
      },
    }

    await configHook(userConfig, { command: "build", mode: "production" })
    await configResolved({ ...userConfig, resolve: { alias: [] } })

    expect(userConfig.nitro.cloudflare.wrangler.containers[0]).toBe(container)
    expect(userConfig.nitro.cloudflare.wrangler.containers).toEqual([{
      class_name: "Sandbox",
      image: "./custom.Dockerfile",
      instance_type: "standard-1",
      max_instances: 2,
      name: "application-owned",
    }])
    await expect(readFile(join(rootDir, ".vitehub/sandbox/Dockerfile"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" })
    const [rollupPlugin] = (userConfig.nitro as typeof userConfig.nitro & {
      rollupConfig: { plugins: Array<{ renderChunk: (code: string, chunk: { exports: string[], fileName: string, isEntry: boolean }) => unknown }> }
    }).rollupConfig.plugins
    expect(rollupPlugin.renderChunk("export class Sandbox {}", { exports: ["Sandbox"], isEntry: true, fileName: "index.mjs" }))
      .toMatchObject({ code: expect.stringContaining(`export { ContainerProxy } from "./sandbox-cloudflare-exports.mjs"`) })
    expect(rollupPlugin.renderChunk("class Worker {}; export { Worker as Sandbox }", { exports: ["Sandbox"], isEntry: true, fileName: "index.mjs" }))
      .toMatchObject({ code: expect.stringContaining(`export { ContainerProxy } from "./sandbox-cloudflare-exports.mjs"`) })
    expect(rollupPlugin.renderChunk("class Sandbox {}; export { Sandbox as Worker }", { exports: ["Worker"], isEntry: true, fileName: "index.mjs" }))
      .toMatchObject({ code: expect.stringContaining(`export { Sandbox, ContainerProxy } from "./sandbox-cloudflare-exports.mjs"`) })
    expect(rollupPlugin.renderChunk("export class Sandbox {}; export { ContainerProxy }", { exports: ["Sandbox", "ContainerProxy"], isEntry: true, fileName: "index.mjs" })).toBeNull()
    expect(rollupPlugin.renderChunk("export * from './sandbox.mjs'", { exports: ["Other"], isEntry: true, fileName: "index.mjs" }))
      .toMatchObject({ code: expect.stringContaining(`export { Sandbox, ContainerProxy }`) })
    expect(rollupPlugin.renderChunk("export * from './sandbox.mjs'", { exports: ["Sandbox", "ContainerProxy"], isEntry: true, fileName: "index.mjs" })).toBeNull()
    expect(rollupPlugin.renderChunk("export default {}", { exports: ["default"], isEntry: false, fileName: "chunk.mjs" })).toBeNull()
  })

  it("rejects ContainerProxy as the Cloudflare Sandbox class name", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare", className: "ContainerProxy" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const userConfig = { root: rootDir, plugins: [{ name: "nitro:main" }], nitro: { preset: "cloudflare-module" } }

    await expect(configHook(userConfig, { command: "build", mode: "production" }))
      .rejects.toThrow('className "ContainerProxy" is reserved')
  })

  it("rejects conflicting Cloudflare container build contexts", async () => {
    const { finalizeCloudflareWranglerConfig } = await import("../src/internal/shared/cloudflare-wrangler.ts")
    const target = {
      cloudflare: {
        wrangler: {
          containers: [
            { class_name: "Sandbox", image: "./Dockerfile", image_build_context: "../app" },
            { class_name: "Sandbox", image: "./Dockerfile", image_build_context: "../sandbox" },
          ],
        },
      },
    }

    expect(() => finalizeCloudflareWranglerConfig(target))
      .toThrow('Conflicting Cloudflare container "Sandbox"')
  })

  it("completes only the required image fields on a partial Cloudflare Sandbox container", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare", name: "generated-name" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: Record<string, any>) => unknown | Promise<unknown>
    const container = {
      class_name: "Sandbox",
      instance_type: "standard-1",
      max_instances: 2,
      name: "application-owned",
    }
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: {
        preset: "cloudflare-module",
        cloudflare: { wrangler: { containers: [container] } },
        output: { serverDir: ".output/server" },
      },
    }

    await configHook(userConfig, { command: "build", mode: "production" })
    await configResolved({ ...userConfig, resolve: { alias: [] } })

    expect(userConfig.nitro.cloudflare.wrangler.containers[0]).toBe(container)
    expect(userConfig.nitro.cloudflare.wrangler.containers).toEqual([{
      class_name: "Sandbox",
      image: "../../.vitehub/sandbox/Dockerfile",
      image_build_context: "../..",
      instance_type: "standard-1",
      max_instances: 2,
      name: "application-owned",
    }])
  })

  it("completes partial containers configured without Nitro", async () => {
    const { configureCloudflareSandbox } = await import("../src/cloudflare.ts")
    const container = { class_name: "Sandbox", instance_type: "standard-1" }
    const target = { cloudflare: { wrangler: { containers: [container] } } }

    configureCloudflareSandbox(target)

    expect(container).toEqual({
      class_name: "Sandbox",
      image: "./Dockerfile",
      instance_type: "standard-1",
      max_instances: 12,
    })
  })

  it("rejects an existing Cloudflare migration tag without changing it", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const migrations = [{ tag: "v1", new_sqlite_classes: ["Existing"] }]
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: {
        preset: "cloudflare-module",
        cloudflare: { wrangler: { migrations } },
      },
    }

    await expect(configHook(userConfig, { command: "build", mode: "production" }))
      .rejects.toThrow('Cloudflare migration tag "v1" is already in use')
    expect(userConfig.nitro.cloudflare.wrangler).toEqual({
      migrations: [{ tag: "v1", new_sqlite_classes: ["Existing"] }],
    })
  })

  it("preserves existing Cloudflare migration fields and order", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: {
        preset: "cloudflare-module",
        cloudflare: {
          wrangler: {
            migrations: [{ tag: "z-initial", new_classes: ["AnalysisState"] }],
          },
        },
      },
    }

    await configHook(userConfig, { command: "build", mode: "production" })

    expect(userConfig.nitro.cloudflare.wrangler.migrations).toEqual([
      { tag: "z-initial", new_classes: ["AnalysisState"] },
      { tag: "v1", new_sqlite_classes: ["Sandbox"] },
    ])
  })

  it("merges every operation from duplicate Cloudflare migration tags", async () => {
    const { finalizeCloudflareWranglerConfig } = await import("../src/internal/shared/cloudflare-wrangler.ts")
    const target = { cloudflare: { wrangler: { migrations: [
      { tag: "v1", new_classes: ["Legacy"], new_sqlite_classes: ["Existing"] },
      {
        tag: "v1",
        deleted_classes: ["Removed"],
        new_sqlite_classes: ["Sandbox"],
        renamed_classes: [{ from: "Old", to: "Renamed" }],
        transferred_classes: [{ from: "Remote", from_script: "source-worker", to: "Local" }],
      },
      { tag: "v1", deleted_classes: ["Removed"], new_classes: ["Legacy"] },
    ] } } }

    finalizeCloudflareWranglerConfig(target)

    expect(target.cloudflare.wrangler.migrations).toEqual([{
      tag: "v1",
      deleted_classes: ["Removed"],
      new_classes: ["Legacy"],
      new_sqlite_classes: ["Existing", "Sandbox"],
      renamed_classes: [{ from: "Old", to: "Renamed" }],
      transferred_classes: [{ from: "Remote", from_script: "source-worker", to: "Local" }],
    }])
  })

  it("does not require local migrations for external Durable Object bindings", async () => {
    const { finalizeCloudflareWranglerConfig } = await import("../src/internal/shared/cloudflare-wrangler.ts")
    const target = { cloudflare: { wrangler: { durable_objects: { bindings: [
      { name: "REMOTE", class_name: "RemoteObject", script_name: "other-worker" },
    ] } } } }

    expect(() => finalizeCloudflareWranglerConfig(target)).not.toThrow()
  })

  it("rejects Wrangler exports before adding legacy migrations", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const wrangler = { exports: { Existing: "Existing" } }
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: { preset: "cloudflare-module", cloudflare: { wrangler } },
    }

    await expect(configHook(userConfig, { command: "build", mode: "production" }))
      .rejects.toThrow("cannot compose legacy migrations")
    expect(userConfig.nitro.cloudflare.wrangler).toBe(wrangler)
  })

  it("rejects a colliding Cloudflare Durable Object binding before mutation", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const wrangler = {
      durable_objects: { bindings: [{ name: "SANDBOX", class_name: "Existing" }] },
    }
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: { preset: "cloudflare-module", cloudflare: { wrangler } },
    }

    await expect(configHook(userConfig, { command: "build", mode: "production" }))
      .rejects.toThrow('Cloudflare Durable Object binding "SANDBOX" is already in use')
    expect(userConfig.nitro.cloudflare.wrangler).toBe(wrangler)
    expect(wrangler).toEqual({
      durable_objects: { bindings: [{ name: "SANDBOX", class_name: "Existing" }] },
    })
  })

  it("does not compose Cloudflare output for a non-Cloudflare Nitro host", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: { preset: "vercel" } as Record<string, any>,
    }

    await configHook(userConfig, { command: "build", mode: "production" })

    expect(userConfig.nitro).toEqual({ preset: "vercel" })
    const patterns = readSandboxNitroNoExternals(plugin)
    expect(patterns).toHaveLength(2)
    expect(patterns).toContain("@vite-hub/sandbox")
  })

  it("keeps a late-resolved non-Cloudflare Nitro preset authoritative", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: Record<string, any>) => unknown | Promise<unknown>
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: {},
    }

    await configHook(userConfig, { command: "build", mode: "production" })
    expect(userConfig.nitro).toEqual({})

    const resolvedConfig = { ...userConfig, nitro: { preset: "vercel" }, resolve: { alias: [] } }
    await configResolved(resolvedConfig)

    expect(resolvedConfig.nitro).toEqual({ preset: "vercel" })
    expect(readSandboxNitroNoExternals(plugin)).toContain("@cloudflare/sandbox")
  })

  it.each([
    ["cloudflare-module", "cloudflare", "@cloudflare", "vercel"],
    ["vercel", "vercel", "@vercel", "cloudflare"],
  ])("bundles only the %s Sandbox provider into Nitro", async (preset, provider, sdkScope, otherProvider) => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: provider as "cloudflare" | "vercel" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      preset,
      nitro: {},
    }
    await configHook(userConfig, { command: "build", mode: "production" })
    const runNitroBuildBefore = createSandboxNitroLifecycle(plugin, [/existing/])

    const nitroOptions = runNitroBuildBefore()
    const patterns = nitroOptions.noExternals as Array<string | RegExp>
    const aliases = nitroOptions.alias as Record<string, string>
    expect(patterns).toHaveLength(3)
    expect(patterns).toContain("@vite-hub/sandbox")
    expect(patterns).toContain(`${sdkScope}/sandbox`)
    expect(patterns).not.toContain(`@${otherProvider}/sandbox`)
    expect(aliases["vitehub-sandbox-provider-loader"]).toContain("sandbox-provider-loader.mjs")
    expect(Object.keys(aliases)).toEqual(expect.arrayContaining([
      "#vitehub-sandbox-provider-loader",
      "@vite-hub/sandbox/runtime/provider-loader",
      "virtual:vitehub-sandbox-provider-loader",
      "vitehub-sandbox-provider-loader",
    ]))
  })

  it("does not contribute Nitro Sandbox externals when Sandbox is disabled", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox(false)
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const userConfig = { root: rootDir, nitro: {}, preset: "vercel" }
    await configHook(userConfig, { command: "build", mode: "production" })
    const runNitroBuildBefore = createSandboxNitroLifecycle(plugin, [/existing/])

    const nitroOptions = runNitroBuildBefore()
    expect(nitroOptions.noExternals).toEqual([/existing/])
    expect(nitroOptions).not.toHaveProperty("alias")
  })

  it("removes early environment-selected Cloudflare output when Nitro resolves away", async () => {
    const rootDir = await createViteRoot()
    const previousPreset = process.env.NITRO_PRESET
    process.env.NITRO_PRESET = "cloudflare-module"
    try {
      const { hubSandbox } = await import("../src/vite.ts")
      const plugin = hubSandbox({ provider: "cloudflare" })
      const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
      const configResolved = plugin.configResolved as unknown as (config: Record<string, any>) => unknown | Promise<unknown>
      const nitro: Record<string, any> = {}
      const userConfig = { root: rootDir, plugins: [{ name: "nitro:main" }], nitro }

      await configHook(userConfig, { command: "build", mode: "production" })
      expect(nitro.cloudflare.wrangler.containers).toHaveLength(1)

      const resolvedConfig = { ...userConfig, nitro: { preset: "vercel" } as Record<string, any>, resolve: { alias: [] } }
      await configResolved(resolvedConfig)

      expect(nitro).toEqual({})
      expect(resolvedConfig.nitro).toEqual({ preset: "vercel" })
      expect(readSandboxNitroNoExternals(plugin)).toContain("@cloudflare/sandbox")
    }
    finally {
      if (typeof previousPreset === "undefined") delete process.env.NITRO_PRESET
      else process.env.NITRO_PRESET = previousPreset
    }
  })

  it("does not reuse an application Dockerfile for the generated Sandbox image", async () => {
    const rootDir = await createViteRoot()
    await writeFile(join(rootDir, "Dockerfile"), "FROM node:24\n")
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare" })
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const userConfig = {
      root: rootDir,
      plugins: [{ name: "nitro:main" }],
      nitro: { preset: "cloudflare-module" },
    }

    await configHook(userConfig, { command: "build", mode: "production" })

    await expect(readFile(join(rootDir, ".vitehub/sandbox/Dockerfile"), "utf8"))
      .resolves.toMatch(/^FROM docker\.io\/cloudflare\/sandbox:/)
    await expect(readFile(join(rootDir, "Dockerfile"), "utf8")).resolves.toBe("FROM node:24\n")
  })

  it("defers generated definition bundling until Vite aliases are resolved", async () => {
    const rootDir = await createViteRoot()
    await mkdir(join(rootDir, "src/lib"), { recursive: true })
    await writeFile(join(rootDir, "src/lib/message.ts"), `export const message = "from late alias"\n`)
    await writeFile(join(rootDir, "src/tools/release-notes.sandbox.ts"), [
      `import { message } from "#late/message"`,
      ``,
      `export default defineSandbox({ run: async () => ({ message }) })`,
      ``,
    ].join("\n"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: AliasOptions } }) => unknown | Promise<unknown>

    await configHook({
      root: rootDir,
    }, {
      command: "serve",
      mode: "development",
    })
    await configResolved({
      root: rootDir,
      resolve: {
        alias: [
          {
            find: "#late",
            replacement: join(rootDir, "src/lib"),
          },
        ],
      },
    })

    await expect(readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs"), "utf8")).resolves.toContain("from late alias")
  })

  it("lets Vite config override direct integration options", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "cloudflare" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    await configHook({
      root: rootDir,
      sandbox: {
        provider: "vercel",
      },
    }, {
      command: "serve",
      mode: "development",
    })

    const resolvedId = await resolveId("#vitehub/sandbox")
    const code = await load(resolvedId as string)

    expect(code).toContain('"provider": "vercel"')
    expect(code).not.toContain('"provider": "cloudflare"')
  })

  it("preserves explicit disabled sandbox config in feature state", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox(false)
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    await configHook({
      root: rootDir,
    }, {
      command: "serve",
      mode: "development",
    })

    const resolvedId = await resolveId("#vitehub/sandbox")
    const code = await load(resolvedId as string)

    expect(code).toContain('"config": false')
    expect(code).toContain('"sandbox": false')
  })

  it("adds server-environment markers through the Environment API", async () => {
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox()
    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server" }) => unknown

    expect(configEnvironment("rsc", { consumer: "server" })).toEqual({
      define: {
        __VITEHUB_ENVIRONMENT_SANDBOX__: "\"rsc\"",
      },
      resolve: {
        alias: expect.arrayContaining([
          expect.objectContaining({
            find: "vitehub-sandbox-provider-loader",
            replacement: expect.stringContaining("runtime/provider-loader"),
          }),
        ]),
        noExternal: ["@vite-hub/sandbox"],
      },
    })
    expect(configEnvironment("client", { consumer: "client" })).toBeUndefined()
  })

  it.each(["deno-deploy", "netlify", "node-server"])("rejects implicit Sandbox providers for %s hosting", async (hosting) => {
    const { resolveSandboxFeatureConfig } = await import("../src/feature.ts")
    expect(() => resolveSandboxFeatureConfig({}, hosting)).toThrow("does not support " + (hosting === "deno-deploy" ? "deno" : hosting === "node-server" ? "node" : "netlify"))
  })

  it("keeps the runtime provider loader available when provider is inferred later", async () => {
    const { createSandboxFeaturePlan } = await import("../src/feature.ts")
    const plan = await createSandboxFeaturePlan({}, [], {
      aliasPath: "/tmp/vitehub-sandbox/index.js",
    }, {})

    expect(plan.aliases).toContainEqual(expect.objectContaining({
      key: "vitehub-sandbox-provider-loader",
      value: expect.stringContaining("runtime/provider-loader"),
    }))
  })

  it("emits a vercel-only provider loader when only the vercel sdk is installed", async () => {
    const { createSandboxFeaturePlan } = await import("../src/feature.ts")
    const plan = await createSandboxFeaturePlan({}, [], {
      aliasPath: "/tmp/vitehub-sandbox/index.js",
    }, {
      "@vercel/sandbox": "1.0.0",
    })

    expect(plan.aliases).toContainEqual(expect.objectContaining({
      key: "vitehub-sandbox-provider-loader",
      artifactKey: "sandbox-provider-loader",
    }))
    expect(plan.artifacts).toContainEqual(expect.objectContaining({
      key: "sandbox-provider-loader",
    }))
  })

  it("emits a cloudflare-only provider loader when only the cloudflare sdk is installed", async () => {
    const { createSandboxFeaturePlan } = await import("../src/feature.ts")
    const plan = await createSandboxFeaturePlan({}, [], {
      aliasPath: "/tmp/vitehub-sandbox/index.js",
    }, {
      "@cloudflare/sandbox": "1.0.0",
    })

    expect(plan.aliases).toContainEqual(expect.objectContaining({
      key: "vitehub-sandbox-provider-loader",
      artifactKey: "sandbox-provider-loader",
    }))
    expect(plan.artifacts).toContainEqual(expect.objectContaining({
      key: "sandbox-provider-loader",
    }))
  })

  it("rejects generated sandbox artifact path collisions", async () => {
    const { createSandboxFeaturePlan } = await import("../src/feature.ts")

    await expect(createSandboxFeaturePlan({}, [
      { handler: "/tmp/tools/release-notes.ts", kind: "definition", name: "tools/release-notes", source: "vite-suffix", _meta: { filename: "tools/release-notes", sourcePath: "/tmp/tools/release-notes.ts" } },
      { handler: "/tmp/tools__release-notes.ts", kind: "definition", name: "tools__release-notes", source: "vite-suffix", _meta: { filename: "tools__release-notes", sourcePath: "/tmp/tools__release-notes.ts" } },
    ], {
      aliasPath: "/tmp/vitehub-sandbox/index.js",
    }, {})).rejects.toThrow("generate the same artifact path")
  })

  it("emits explicit Cloudflare targets without definitions", async () => {
    const { createSandboxFeaturePlan } = await import("../src/feature.ts")
    const plan = await createSandboxFeaturePlan({ provider: "cloudflare", name: "custom-sandbox" }, [], {
      aliasPath: "/tmp/vitehub-sandbox/index.js",
    }, {})

    expect(plan.cloudflare).toEqual({
      binding: "SANDBOX",
      className: "Sandbox",
      migrationTag: "v1",
      name: "custom-sandbox",
    })
  })

  it("keeps the active runtime intact across independent concurrent writers", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugins = Array.from({ length: 4 }, () => hubSandbox({ provider: "vercel" }))
    const resolvedConfig = { root: rootDir, resolve: { alias: [] as [] } }

    await Promise.all(plugins.map(async (plugin) => {
      const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
      await configHook({ root: rootDir }, { command: "build", mode: "production" })
    }))
    await Promise.all(plugins.map(async (plugin) => {
      const configResolved = plugin.configResolved as unknown as (config: typeof resolvedConfig) => unknown | Promise<unknown>
      await configResolved(resolvedConfig)
    }))

    const runtimeDir = join(rootDir, ".vitehub/sandbox/runtime")
    const activeGeneration = await realpath(runtimeDir)
    const generations = await readdir(join(rootDir, ".vitehub/sandbox/.runtime-generations"))
    expect(generations).toHaveLength(2)
    expect(generations).toContain(basename(activeGeneration))
    await expect(readFile(join(runtimeDir, "sandbox.mjs"), "utf8")).resolves.toContain("setSandboxRuntimeRegistry(sandboxRegistry)")
  })

  it("refreshes generated artifacts during sandbox definition hot updates", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({
      root: rootDir,
    }, {
      command: "serve",
      mode: "development",
    })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server" }) => unknown
    const sandboxAlias = readAlias((configEnvironment("ssr", { consumer: "server" }) as { resolve: { alias: AliasOptions } }).resolve.alias, "@vite-hub/sandbox")!
    const registryAlias = join(rootDir, ".vitehub/sandbox/runtime/sandbox-registry.mjs")
    const definitionArtifact = join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs")
    const previousResolvedSandbox = await realpath(sandboxAlias)
    const previousResolvedRegistry = await realpath(registryAlias)
    const previousResolvedDefinition = await realpath(definitionArtifact)
    const previousRegistryModule: { default: Record<string, () => Promise<unknown>> } = await import(pathToFileURL(previousResolvedRegistry).href)
    const loadPreviousDefinition = previousRegistryModule.default["tools/release-notes"]
    if (!loadPreviousDefinition)
      throw new Error("Expected the previous sandbox registry to contain tools/release-notes.")
    await expect(readFile(previousResolvedRegistry, "utf8")).resolves.toContain(JSON.stringify(previousResolvedDefinition))
    const definition = join(rootDir, "src/tools/release-notes.sandbox.ts")
    const invalidated: string[] = []
    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>

    await writeFile(definition, [
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      ``,
      `export default defineSandbox({ run: async () => ({ message: "updated" }) })`,
      ``,
    ].join("\n"))
    await handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if ([sandboxAlias, registryAlias, definitionArtifact].includes(id) || id.includes("/.runtime-generations/"))
              return { id }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    const currentResolvedDefinition = await realpath(definitionArtifact)
    expect(invalidated).toEqual(expect.arrayContaining([
      sandboxAlias,
      registryAlias,
      definitionArtifact,
      previousResolvedSandbox,
      previousResolvedRegistry,
      previousResolvedDefinition,
      await realpath(sandboxAlias),
      await realpath(registryAlias),
      currentResolvedDefinition,
    ]))
    await expect(readFile(previousResolvedRegistry, "utf8")).resolves.toContain(JSON.stringify(previousResolvedDefinition))
    await expect(readFile(previousResolvedRegistry, "utf8")).resolves.not.toContain(JSON.stringify(currentResolvedDefinition))
    await expect(readFile(await realpath(registryAlias), "utf8")).resolves.toContain(JSON.stringify(currentResolvedDefinition))
    await expect(readFile(definitionArtifact, "utf8")).resolves.toContain("updated")

    await writeFile(definition, "export default { run: async () => ({ message: 'latest' }) }\n")
    await handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById: () => undefined,
          invalidateModule: () => {},
        },
      },
    })
    const generations = await readdir(join(rootDir, ".vitehub/sandbox/.runtime-generations"))
    expect(generations).toHaveLength(2)
    await expect(readFile(previousResolvedDefinition, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(loadPreviousDefinition()).resolves.toBeDefined()
  })

  it("invalidates each generated runtime before starting the next hot refresh", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({ root: rootDir }, { command: "serve", mode: "development" })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server" }) => unknown
    const sandboxAlias = readAlias((configEnvironment("ssr", { consumer: "server" }) as { resolve: { alias: AliasOptions } }).resolve.alias, "@vite-hub/sandbox")!
    const definition = join(rootDir, "src/tools/release-notes.sandbox.ts")
    const invalidated: string[] = []
    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string }
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>
    const context = {
      file: definition,
      server: {
        moduleGraph: {
          getModuleById: (id: string) => ({ id }),
          invalidateModule: (module: { id: string }) => invalidated.push(module.id),
        },
      },
    }

    const firstPrepared = createDeferred()
    const releaseFirst = createDeferred()
    const secondStarted = createDeferred()
    let preparation = 0
    runtimePreparationMock.beforePrepare = async () => {
      preparation += 1
      if (preparation === 2)
        secondStarted.resolve()
    }
    runtimePreparationMock.afterPrepare = async () => {
      if (preparation === 1) {
        firstPrepared.resolve()
        await releaseFirst.promise
      }
    }

    await writeFile(definition, "export default { run: async () => ({ message: 'first' }) }\n")
    const firstUpdate = handleHotUpdate(context)
    await firstPrepared.promise
    const firstGenerationSandbox = await realpath(sandboxAlias)

    await writeFile(definition, "export default { run: async () => ({ message: 'second' }) }\n")
    const secondUpdate = handleHotUpdate(context)
    releaseFirst.resolve()
    await secondStarted.promise

    expect(invalidated).toContain(firstGenerationSandbox)
    await Promise.all([firstUpdate, secondUpdate])
    await expect(readFile(sandboxAlias, "utf8")).resolves.toContain("setSandboxRuntimeConfig")
  })

  it("removes generated bundles for definitions that no longer exist", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({ root: rootDir }, { command: "serve", mode: "development" })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const previousDefinition = join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs")
    await expect(readFile(previousDefinition, "utf8")).resolves.toContain("release-notes")

    await rm(join(rootDir, "src/tools/release-notes.sandbox.ts"))
    await writeFile(join(rootDir, "src/tools/next.sandbox.ts"), [
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      `export default defineSandbox({ run: async () => ({ next: true }) })`,
      ``,
    ].join("\n"))
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    await expect(readFile(previousDefinition, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__next.mjs"), "utf8")).resolves.toContain("next")
  })

  it("keeps Windows definition fallbacks in the active runtime", async () => {
    const rootDir = await createViteRoot()
    const { prepareSandboxRuntime } = await import("../src/internal/runtime-preparation.ts")
    const options = {
      env: { command: "serve" as const, mode: "development" },
      platform: "win32" as const,
      userConfig: { root: rootDir },
    }

    await prepareSandboxRuntime(options)
    const stableDefinition = join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs")
    const generationsDir = join(rootDir, ".vitehub/sandbox/.runtime-generations")
    const [previousGeneration] = (await readdir(generationsDir)).filter(entry => entry.startsWith("runtime-"))
    if (!previousGeneration)
      throw new Error("Expected the initial Windows runtime generation to exist.")
    const previousDefinition = join(generationsDir, previousGeneration, "sandbox-definitions/tools__release-notes.mjs")
    const previousRegistryModule: { default: Record<string, () => Promise<unknown>> } = await import(
      pathToFileURL(join(generationsDir, previousGeneration, "sandbox-registry.mjs")).href,
    )
    const loadPreviousDefinition = previousRegistryModule.default["tools/release-notes"]
    if (!loadPreviousDefinition)
      throw new Error("Expected the previous Windows registry to contain tools/release-notes.")
    await expect(readFile(stableDefinition, "utf8")).resolves.toContain("release-notes")

    const definition = join(rootDir, "src/tools/release-notes.sandbox.ts")
    await writeFile(definition, "export default { run: async () => ({ message: 'updated' }) }\n")
    await prepareSandboxRuntime(options)
    await writeFile(definition, "export default { run: async () => ({ message: 'latest' }) }\n")
    await prepareSandboxRuntime(options)

    await expect(readFile(previousDefinition, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(stableDefinition, "utf8")).resolves.toContain("latest")
    await expect(loadPreviousDefinition()).resolves.toBeDefined()
  })

  it("keeps the last valid generated bundles when regeneration fails", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({ root: rootDir }, { command: "serve", mode: "development" })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const definition = join(rootDir, "src/tools/release-notes.sandbox.ts")
    const generated = join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs")
    const previous = await readFile(generated, "utf8")
    expect((await lstat(join(rootDir, ".vitehub/sandbox/runtime"))).isSymbolicLink()).toBe(true)
    await writeFile(definition, "export default { run: async () => {\n")

    await expect(configResolved({ root: rootDir, resolve: { alias: [] } })).rejects.toThrow()
    await expect(readFile(generated, "utf8")).resolves.toBe(previous)
  })

  it("refreshes generated options when a Sandbox project manifest changes", async () => {
    const rootDir = await createViteRoot()
    const projectDir = join(rootDir, "server/sandboxes/example")
    const manifest = join(projectDir, "package.json")
    const definition = join(projectDir, "index.ts")
    await rm(join(rootDir, "src/tools/release-notes.sandbox.ts"))
    await mkdir(projectDir, { recursive: true })
    await writeFile(manifest, JSON.stringify({
      private: true,
      type: "module",
      vitehub: { sandbox: { timeout: 30_000 } },
    }))
    await writeFile(definition, "export default async function run() { return { ok: true } }\n")
    await writeFile(join(projectDir, "prompt.md"), "initial prompt")

    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({
      root: rootDir,
    }, {
      command: "serve",
      mode: "development",
    })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server" }) => unknown
    const sandboxAlias = readAlias((configEnvironment("ssr", { consumer: "server" }) as { resolve: { alias: AliasOptions } }).resolve.alias, "@vite-hub/sandbox")!
    const registryAlias = join(rootDir, ".vitehub/sandbox/runtime/sandbox-registry.mjs")
    const definitionArtifact = join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/example.mjs")
    const invalidated: string[] = []
    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>
    const readTimeout = async () => {
      const generated = await readFile(definitionArtifact, "utf8")
      return JSON.parse(generated.slice("export default ".length)).options?.timeout
    }
    const readPrompt = async () => {
      const generated = await readFile(definitionArtifact, "utf8")
      const prompt = JSON.parse(generated.slice("export default ".length)).bundle.project.files["prompt.md"]
      return Buffer.from(prompt.contents, prompt.encoding).toString()
    }

    await expect(readTimeout()).resolves.toBe(30_000)
    await writeFile(manifest, JSON.stringify({
      private: true,
      type: "module",
      vitehub: { sandbox: { timeout: 60_000 } },
    }))
    await handleHotUpdate({
      file: manifest,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if ([sandboxAlias, registryAlias, definitionArtifact].includes(id))
              return { id }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual(expect.arrayContaining([sandboxAlias, registryAlias, definitionArtifact]))
    await expect(readTimeout()).resolves.toBe(60_000)

    const prompt = join(projectDir, "prompt.md")
    await writeFile(prompt, "updated prompt")
    await handleHotUpdate({
      file: prompt,
      server: {
        moduleGraph: {
          getModuleById: () => undefined,
          invalidateModule: () => {},
        },
      },
    })
    await expect(readPrompt()).resolves.toBe("updated prompt")
  })

  it("discovers a Sandbox when its package manifest is added during development", async () => {
    const rootDir = await createViteRoot()
    const projectDir = join(rootDir, "server/sandboxes/example")
    const manifest = join(projectDir, "package.json")
    await rm(join(rootDir, "src/tools/release-notes.sandbox.ts"))
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, "index.ts"), "export default async function run() { return { ok: true } }\n")

    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({ root: rootDir }, { command: "serve", mode: "development" })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const registry = join(rootDir, ".vitehub/sandbox/runtime/sandbox-registry.mjs")
    await expect(readFile(registry, "utf8")).resolves.not.toContain('"example"')
    await writeFile(manifest, JSON.stringify({ private: true, type: "module" }))

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: { moduleGraph: { getModuleById: () => undefined, invalidateModule: () => void } }
    }) => Promise<void>
    await handleHotUpdate({
      file: manifest,
      server: { moduleGraph: { getModuleById: () => undefined, invalidateModule: () => {} } },
    })

    await expect(readFile(registry, "utf8")).resolves.toContain('"example"')
  })

  it("refreshes generated artifacts when imported local modules change", async () => {
    const rootDir = await createViteRoot()
    const helper = join(rootDir, "src/tools/message.ts")
    const definition = join(rootDir, "src/tools/release-notes.sandbox.ts")
    await writeFile(helper, `export const message = "initial"\n`)
    await writeFile(definition, [
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      `import { message } from "./message"`,
      ``,
      `export default defineSandbox({ run: async () => ({ message }) })`,
      ``,
    ].join("\n"))
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({
      root: rootDir,
    }, {
      command: "serve",
      mode: "development",
    })
    await configResolved({ root: rootDir, resolve: { alias: [] } })

    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server" }) => unknown
    const sandboxAlias = readAlias((configEnvironment("ssr", { consumer: "server" }) as { resolve: { alias: AliasOptions } }).resolve.alias, "@vite-hub/sandbox")!
    const registryAlias = join(rootDir, ".vitehub/sandbox/runtime/sandbox-registry.mjs")
    const definitionArtifact = join(rootDir, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs")
    const invalidated: string[] = []
    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>

    await expect(readFile(definitionArtifact, "utf8")).resolves.toContain("initial")
    await writeFile(helper, `export const message = "updated helper"\n`)
    await handleHotUpdate({
      file: helper,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if ([sandboxAlias, registryAlias, definitionArtifact].includes(id))
              return { id }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual(expect.arrayContaining([sandboxAlias, registryAlias, definitionArtifact]))
    await expect(readFile(definitionArtifact, "utf8")).resolves.toContain("updated helper")
  })

  it("watches Sandbox project files from the owned project root", async () => {
    const projectRoot = await createViteRoot()
    const viteRoot = join(projectRoot, "app")
    const helper = join(projectRoot, "src/tools/message.ts")
    const definition = join(projectRoot, "src/tools/release-notes.sandbox.ts")
    await mkdir(viteRoot)
    await writeFile(helper, `export const message = "initial"\n`)
    await writeFile(definition, [
      `import { message } from "./message"`,
      `export default { run: async () => ({ message }) }`,
      ``,
    ].join("\n"))

    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox({ provider: "vercel" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: { root: string, resolve: { alias: [] } }) => unknown | Promise<unknown>
    await configHook({ root: viteRoot, __vitehubProjectRoot: projectRoot }, { command: "serve", mode: "development" })
    await configResolved({ root: viteRoot, resolve: { alias: [] } })

    const artifact = join(projectRoot, ".vitehub/sandbox/runtime/sandbox-definitions/tools__release-notes.mjs")
    await expect(readFile(artifact, "utf8")).resolves.toContain("initial")
    await writeFile(helper, `export const message = "updated"\n`)

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: { moduleGraph: { getModuleById: () => undefined, invalidateModule: () => void } }
    }) => Promise<void>
    await handleHotUpdate({
      file: helper,
      server: { moduleGraph: { getModuleById: () => undefined, invalidateModule: () => {} } },
    })

    await expect(readFile(artifact, "utf8")).resolves.toContain("updated")
  })
})
