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
  it("exposes Vite Sandbox state", async () => {
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

  it("keeps Node built-ins out of definition bundle aliases", async () => {
    const rootDir = await createViteRoot()
    await mkdir(join(rootDir, "src/lib"), { recursive: true })
    await writeFile(join(rootDir, "src/lib/version.ts"), `export const version = "from slash alias"\n`)
    await writeFile(join(rootDir, "src/tools/release-notes.sandbox.ts"), [
      `import { execFileSync } from "node:child_process"`,
      `import { version } from "@/lib/version"`,
      ``,
      `export default defineSandbox(async () => ({ version, node: execFileSync(process.execPath, ["--version"]).toString() }))`,
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
          { find: "process/", replacement: "/virtual/process" },
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
  })

  it("infers Cloudflare from a late-resolved Nitro preset", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox()
    const configHook = plugin.config as (config: Record<string, any>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
    const configResolved = plugin.configResolved as unknown as (config: Record<string, any>) => unknown | Promise<unknown>
    const userConfig = { root: rootDir }

    await configHook(userConfig, { command: "build", mode: "production" })
    const resolvedConfig = {
      ...userConfig,
      nitro: { preset: "cloudflare-module" },
      plugins: [{ name: "nitro:main" }],
      resolve: { alias: [] },
    }
    await configResolved(resolvedConfig)

    expect((resolvedConfig.nitro as any).cloudflare.wrangler.containers).toMatchObject([{ class_name: "Sandbox" }])
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
        rollupConfig: { plugins: existingPlugin },
      },
    }

    await configHook(userConfig, { command: "build", mode: "production" })
    await configResolved({ ...userConfig, resolve: { alias: [] } })

    expect(userConfig.nitro.cloudflare.wrangler).toMatchObject({
      compatibility_flags: ["custom", "nodejs_compat"],
      containers: [{
        class_name: "Sandbox",
        image: "../../../.vitehub/sandbox/Dockerfile",
        image_build_context: "../../..",
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
      .resolves.toMatch(/^FROM docker\.io\/cloudflare\/sandbox:\d/)

    const configuredNitro = userConfig.nitro as typeof userConfig.nitro & {
      rollupConfig: {
        plugins: Array<{
          load: (id: string) => string
          name: string
          renderChunk: (code: string, chunk: { fileName: string, isEntry: boolean }) => { code: string }
        }>
      }
    }
    expect(configuredNitro.rollupConfig.plugins[0]).toBe(existingPlugin)
    const rollupPlugin = configuredNitro.rollupConfig.plugins[1]
    expect(rollupPlugin.name).toBe("vitehub-sandbox-cloudflare-exports:Sandbox")
    expect(rollupPlugin.load("\0virtual:vitehub-sandbox-cloudflare-exports"))
      .toContain("export class Sandbox extends CloudflareSandbox")
    expect(rollupPlugin.renderChunk("export default {}", { isEntry: true, fileName: "index.mjs" }).code)
      .toContain(`export { Sandbox } from './sandbox-cloudflare-exports.mjs'`)
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
      rollupConfig: { plugins: Array<{ renderChunk: (code: string, chunk: { fileName: string, isEntry: boolean }) => unknown }> }
    }).rollupConfig.plugins
    expect(rollupPlugin.renderChunk("export class Sandbox {}", { isEntry: true, fileName: "index.mjs" })).toBeNull()
    expect(rollupPlugin.renderChunk("class Worker {}; export { Worker as Sandbox }", { isEntry: true, fileName: "index.mjs" })).toBeNull()
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
      nitro: { preset: "vercel" },
    }

    await configHook(userConfig, { command: "build", mode: "production" })

    expect(userConfig.nitro).toEqual({ preset: "vercel" })
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
