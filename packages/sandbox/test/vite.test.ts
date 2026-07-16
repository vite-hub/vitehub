import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import type { AliasOptions } from "vite"

const tempDirs: string[] = []

function readAlias(alias: AliasOptions | undefined, id: string) {
  if (Array.isArray(alias)) {
    return alias.find((entry) => {
      if (typeof entry.find === "string") return entry.find === id
      return entry.find.test(id)
    })?.replacement
  }

  return (alias as Record<string, string> | undefined)?.[id]
}

async function createViteRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-sandbox-vite-"))
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
    `export default defineSandbox(async () => ({ ok: true }))`,
    ``,
  ].join("\n"))
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("hubSandbox", () => {
  it("exposes Vite feature state", async () => {
    const rootDir = await createViteRoot()
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

    expect(code).toContain('"feature": "sandbox"')
    expect(code).toContain('"provider": "vercel"')
    const alias = (configResult as { resolve: { alias: AliasOptions } }).resolve.alias
    const registryAlias = readAlias(alias, "#vitehub-sandbox-registry")!
    const providerLoaderAlias = readAlias(alias, "vitehub-sandbox-provider-loader")!
    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server" }) => unknown
    const serverConfig = configEnvironment("ssr", { consumer: "server" }) as { resolve: { alias: AliasOptions } }
    const sandboxAlias = readAlias(serverConfig.resolve.alias, "@vite-hub/sandbox")!

    expect(readAlias(alias, "@vite-hub/sandbox")).toBeUndefined()
    expect(sandboxAlias).toContain(".vitehub/sandbox/runtime/sandbox.mjs")
    expect(providerImportAliases["@vite-hub/sandbox"]).toBe(sandboxAlias)
    expect(providerImportAliases["vite-hub/sandbox"]).toBe(sandboxAlias)

    await configHook({ root: rootDir, sandbox: false }, { command: "serve", mode: "development" })
    await configResolved({ root: rootDir, resolve: { alias: [] } })
    expect(providerImportAliases).not.toHaveProperty("@vite-hub/sandbox")
    expect(providerImportAliases).not.toHaveProperty("vite-hub/sandbox")
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
    expect(registry).toContain('"tools/release-notes"')
    expect(providerLoader).toContain("createVercelSandboxClient")
    expect(providerLoader).not.toContain("import('./providers/vercel.js')")
    await expect(readFile(join(rootDir, ".vitehub/sandbox/runtime/sandbox.d.ts"), "utf8")).resolves.toContain('"tools/release-notes"')
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
      `export default defineSandbox(async () => ({ message }))`,
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

  it("defers generated definition bundling until Vite aliases are resolved", async () => {
    const rootDir = await createViteRoot()
    await mkdir(join(rootDir, "src/lib"), { recursive: true })
    await writeFile(join(rootDir, "src/lib/message.ts"), `export const message = "from late alias"\n`)
    await writeFile(join(rootDir, "src/tools/release-notes.sandbox.ts"), [
      `import { message } from "#late/message"`,
      ``,
      `export default defineSandbox(async () => ({ message }))`,
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
      { handler: "/tmp/tools/release-notes.ts", name: "tools/release-notes", _meta: { filename: "tools/release-notes", sourcePath: "/tmp/tools/release-notes.ts" } },
      { handler: "/tmp/tools__release-notes.ts", name: "tools__release-notes", _meta: { filename: "tools__release-notes", sourcePath: "/tmp/tools__release-notes.ts" } },
    ], {
      aliasPath: "/tmp/vitehub-sandbox/index.js",
    }, {})).rejects.toThrow("generate the same artifact path")
  })

  it("passes explicit Cloudflare sandbox container names to Cloudflare targets", async () => {
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
      `export default defineSandbox(async () => ({ message: "updated" }))`,
      ``,
    ].join("\n"))
    await handleHotUpdate({
      file: definition,
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
    await expect(readFile(definitionArtifact, "utf8")).resolves.toContain("updated")
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
      `export default defineSandbox(async () => ({ message }))`,
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
})
