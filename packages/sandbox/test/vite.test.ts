import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []

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
  it("exposes Vite feature state and attaches a Nitro bridge", async () => {
    const rootDir = await createViteRoot()
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox()
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "serve" | "build", mode: string }) => unknown | Promise<unknown>
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

    const resolvedId = await resolveId("#vitehub/sandbox")
    const code = await load(resolvedId as string)

    expect(plugin.nitro?.name).toBe("@vite-hub/sandbox")
    expect(code).toContain('"feature": "sandbox"')
    expect(code).toContain('"provider": "vercel"')
    expect(configResult).toEqual({
      resolve: {
        alias: {
          "vitehub-sandbox-provider-loader": expect.stringContaining("runtime/provider-loader"),
        },
      },
    })
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

  it("adds server-environment markers through the Environment API", async () => {
    const { hubSandbox } = await import("../src/vite.ts")
    const plugin = hubSandbox()
    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server" }) => unknown

    expect(configEnvironment("rsc", { consumer: "server" })).toEqual({
      define: {
        __VITEHUB_ENVIRONMENT_SANDBOX__: "\"rsc\"",
      },
      resolve: {
        alias: {
          "vitehub-sandbox-provider-loader": expect.stringContaining("runtime/provider-loader"),
        },
        noExternal: ["@vite-hub/sandbox"],
      },
    })
    expect(configEnvironment("client", { consumer: "client" })).toBeUndefined()
  })

  it("keeps the runtime provider loader available when provider is inferred later", async () => {
    const { createSandboxFeaturePlan } = await import("../src/feature.ts")
    const plan = await createSandboxFeaturePlan({}, [], {
      aliasPath: "/tmp/vitehub-sandbox/index.js",
      nitroPlugin: "/tmp/vitehub-sandbox/runtime/nitro-plugin.js",
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
      nitroPlugin: "/tmp/vitehub-sandbox/runtime/nitro-plugin.js",
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
      nitroPlugin: "/tmp/vitehub-sandbox/runtime/nitro-plugin.js",
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

  it("adds a Nitro build resolver for provider loader aliases", async () => {
    const { addSandboxProviderLoaderResolver } = await import("../src/nitro/setup.ts")
    const hookCalls: Array<{ name: string, handler: (nitro: unknown, config: { plugins?: Array<{ resolveId?: (id: string) => string | undefined }> }) => void }> = []
    const nitro = {
      hooks: {
        hook(name: string, handler: (nitro: unknown, config: { plugins?: Array<{ resolveId?: (id: string) => string | undefined }> }) => void) {
          hookCalls.push({ name, handler })
        },
      },
    }

    addSandboxProviderLoaderResolver(nitro as never, [
      { key: "vitehub-sandbox-provider-loader", value: "/tmp/provider-loader.mjs" },
    ])

    const config: { plugins?: Array<{ resolveId?: (id: string) => string | undefined }> } = {}
    hookCalls[0]?.handler(nitro, config)

    expect(hookCalls[0]?.name).toBe("rollup:before")
    expect(config.plugins?.[0]?.resolveId?.("vitehub-sandbox-provider-loader")).toBe("/tmp/provider-loader.mjs")
    expect(config.plugins?.[0]?.resolveId?.("@vite-hub/sandbox")).toBeUndefined()
  })

  it("passes explicit Cloudflare sandbox container names to Nitro targets", async () => {
    const { createSandboxFeaturePlan } = await import("../src/feature.ts")
    const { extendSandboxNitro } = await import("../src/nitro/setup.ts")
    const target: Record<string, unknown> = {}
    const plan = await createSandboxFeaturePlan({ provider: "cloudflare", name: "custom-sandbox" }, [], {
      aliasPath: "/tmp/vitehub-sandbox/index.js",
      nitroPlugin: "/tmp/vitehub-sandbox/runtime/nitro-plugin.js",
    }, {})

    expect(plan.extendNitro).toEqual(expect.any(Function))
    if (!plan.extendNitro) throw new Error("Expected sandbox feature plan to expose extendNitro.")
    plan.extendNitro(target as never, new Map())

    expect(target).toMatchObject({
      cloudflare: {
        wrangler: {
          containers: [
            expect.objectContaining({ class_name: "Sandbox", name: "custom-sandbox" }),
          ],
        },
      },
    })

    const nitroTarget = {
      hooks: {
        hook: () => undefined,
      },
      options: {},
    }
    extendSandboxNitro(nitroTarget as never, { provider: "cloudflare", name: "nitro-sandbox" }, {}, "cloudflare")

    expect(nitroTarget.options).toMatchObject({
      cloudflare: {
        wrangler: {
          containers: [
            expect.objectContaining({ class_name: "Sandbox", name: "nitro-sandbox" }),
          ],
        },
      },
    })
  })
})
