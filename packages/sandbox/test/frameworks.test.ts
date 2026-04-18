import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

interface NuxtModuleDefinitionLike {
  setup: (inlineOptions: unknown, nuxt: unknown) => void | Promise<void>
}

const defineNuxtModule = vi.fn((definition: NuxtModuleDefinitionLike) => {
  return async (inlineOptions: unknown, nuxt: unknown) => {
    await definition.setup(inlineOptions, nuxt)
  }
})

vi.mock("@nuxt/kit", () => ({
  defineNuxtModule,
}))

const tempDirs: string[] = []

async function createFixtureRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-sandbox-"))
  tempDirs.push(rootDir)

  await writeFile(join(rootDir, "package.json"), JSON.stringify({
    name: "vitehub-sandbox-fixture",
    private: true,
    type: "module",
    dependencies: {
      "@cloudflare/sandbox": "0.8.11",
      "@vercel/sandbox": "1.10.0",
    },
  }, null, 2))
  await mkdir(join(rootDir, "server/sandboxes"), { recursive: true })
  await writeFile(join(rootDir, "server/sandboxes/release-notes.ts"), [
    `import { defineSandbox } from "@vitehub/sandbox"`,
    ``,
    `export default defineSandbox(async (payload?: { notes?: string }) => ({`,
    `  summary: payload?.notes || "empty",`,
    `}), {`,
    `  timeout: 10_000,`,
    `  runtime: { command: "node", args: ["--enable-source-maps"] },`,
    `})`,
    ``,
  ].join("\n"))

  return rootDir
}

function createNitroStub(rootDir: string, options: Record<string, unknown> = {}) {
  const hooks = new Map<string, ((payload?: any) => void | Promise<void>)[]>()

  return {
    options: {
      rootDir,
      srcDir: "server",
      buildDir: join(rootDir, ".nitro"),
      alias: {},
      plugins: [],
      imports: { presets: [] },
      handlers: [],
      runtimeConfig: {},
      ...options,
    },
    hooks: {
      hook(name: string, fn: (payload?: any) => void | Promise<void>) {
        hooks.set(name, [...(hooks.get(name) || []), fn])
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    _hooks: hooks,
  }
}

function createNuxtHarness(options: Record<string, any> = {}) {
  const hooks = new Map<string, ((payload: unknown) => void | Promise<void>)[]>()

  return {
    hook(name: string, fn: (payload: unknown) => void | Promise<void>) {
      hooks.set(name, [...(hooks.get(name) || []), fn])
    },
    async runHook(name: string, payload: unknown) {
      for (const fn of hooks.get(name) || []) {
        await fn(payload)
      }
    },
    options,
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
  defineNuxtModule.mockClear()
})

describe("sandbox public api", () => {
  it("exposes defineSandbox without the inline factory api", async () => {
    const sandboxPackage = await import("../src/index.ts")
    const definition = sandboxPackage.defineSandbox(async (payload?: { value?: string }) => payload?.value, {
      env: { FOO: "bar" },
      runtime: { command: "node", args: ["--trace-warnings"] },
      timeout: 1000,
    })

    expect("createSandbox" in sandboxPackage).toBe(false)
    expect(definition.options).toEqual({
      env: { FOO: "bar" },
      runtime: { command: "node", args: ["--trace-warnings"] },
      timeout: 1000,
    })
  })

  it("returns a result wrapper instead of throwing", async () => {
    const { runSandbox } = await import("../src/index.ts")
    const result = await runSandbox("missing")

    expect(result.isErr()).toBe(true)
    expect(result.isOk()).toBe(false)
    if (result.isErr()) {
      expect(result.error!.message).toContain("missing")
    }
  })
})

describe("sandbox framework modules", () => {
  it("installs Nitro artifacts from server/sandboxes discovery", async () => {
    const rootDir = await createFixtureRoot()
    const nitro = createNitroStub(rootDir, {
      preset: "cloudflare-module",
      sandbox: {
        provider: "cloudflare",
      },
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    const alias = nitro.options.alias as Record<string, string>
    expect(alias["@vitehub/sandbox"]).toContain("/packages/sandbox/src/index")
    expect(alias["#vitehub-sandbox-registry"]).toContain("sandbox-registry.mjs")
    expect(alias["#vitehub-sandbox-provider-loader"]).toContain("sandbox-provider-loader.mjs")
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.runtimeConfig).toMatchObject({
      hosting: "cloudflare-module",
      sandbox: {
        provider: "cloudflare",
      },
    })
  })

  it("seeds Vercel credential placeholders", async () => {
    const rootDir = await createFixtureRoot()
    const nitro = createNitroStub(rootDir, {
      preset: "vercel",
      sandbox: {
        provider: "vercel",
      },
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig).toMatchObject({
      sandbox: {
        provider: "vercel",
        projectId: "",
        teamId: "",
        token: "",
      },
    })
  })

  it("installs the Nitro module from Nuxt and respects sandbox false", async () => {
    const sandboxModule = (await import("../src/nuxt/module.ts")).default
    const disabled = createNuxtHarness({ sandbox: false })

    await sandboxModule(undefined as never, disabled as never)
    expect(disabled.options.nitro).toBeUndefined()

    const enabled = createNuxtHarness({
      sandbox: { provider: "vercel" },
      nitro: { modules: [] },
    })
    await sandboxModule(undefined as never, enabled as never)

    expect(enabled.options.nitro.modules).toEqual(["@vitehub/sandbox/nitro"])
    expect(enabled.options.nitro.sandbox).toEqual({ provider: "vercel" })
  })
})
