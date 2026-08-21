import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { resolveViteHubProjectRoot, VITEHUB_GENERATED_ROOT, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { PluginOption } from "vite"

const databaseRuntimeState = fileURLToPath(new URL("../src/_internal/database/runtime/state", import.meta.url))

const mocks = vi.hoisted(() => ({
  objectHook: vi.fn((config: { nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
    },
  })),
  existingQueueConfig: vi.fn(),
  existingQueueNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    queues: {
      handlers: [{ handler: "custom-server/queues/email.ts" }],
    },
  })),
  existingOwnerConfig: vi.fn((config: { nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      ownerPlugin: true,
    },
  })),
  envHook: vi.fn((config: Record<string, unknown>) => {
    config.envReady = true
  }),
  outputHook: vi.fn(),
  agentHook: vi.fn((config: { [VITEHUB_SERVER_DIRS]?: string[], nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      handlers: config[VITEHUB_SERVER_DIRS]?.map(serverDir => ({ handler: `${serverDir}/agents/support.ts` })),
      modules: ["agent-module"],
    },
  })),
  agentWorkflowRegistryTransform: vi.fn((code: string) => `// transformed\n${code}`),
  queueNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    unexpectedQueue: true,
  })),
  sandboxHook: vi.fn((config: { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean, nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      sandbox: config[VITEHUB_NITRO_CONFIG_CONTEXT],
    },
  })),
  useEnvPlugin: vi.fn(),
  vitehub: vi.fn(),
  workflowNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    workflows: true,
  })),
}))

vi.mock("../src/index.ts", () => ({ vitehub: mocks.vitehub }))

import viteHubNuxtModule from "../src/nuxt.ts"

function createNuxt(dev = false, plugins: PluginOption[] = []) {
  const nitroConfigHooks: Array<(config: Record<string, unknown>) => Promise<void>> = []
  const nuxt = {
    hook(name: "nitro:config", callback: (config: Record<string, unknown>) => Promise<void>) {
      if (name === "nitro:config") nitroConfigHooks.push(callback)
    },
    options: {
      alias: {
        "~": "/tmp/vitehub-nuxt/app",
      },
      buildDir: "/tmp/vitehub-nuxt/.nuxt",
      dev,
      rootDir: "/tmp/vitehub-nuxt",
      serverDir: "/tmp/vitehub-nuxt/custom-server",
      srcDir: "/tmp/vitehub-nuxt/app",
      vite: { plugins },
    },
  }
  return {
    nitroConfigHooks,
    nuxt,
    async runNitroConfigHook(config: Record<string, unknown>) {
      if (!nitroConfigHooks.length) throw new TypeError("Expected a Nitro config hook.")
      for (const hook of nitroConfigHooks) await hook(config)
    },
  }
}

describe("ViteHub Nuxt integration", () => {
  beforeEach(() => {
    mocks.objectHook.mockClear()
    mocks.agentHook.mockClear()
    mocks.agentWorkflowRegistryTransform.mockClear()
    mocks.existingQueueConfig.mockClear()
    mocks.existingQueueNitroConfig.mockClear()
    mocks.existingOwnerConfig.mockClear()
    mocks.envHook.mockClear()
    mocks.outputHook.mockClear()
    mocks.queueNitroConfig.mockClear()
    mocks.sandboxHook.mockClear()
    mocks.useEnvPlugin.mockClear()
    mocks.workflowNitroConfig.mockClear()
    mocks.vitehub.mockReset()
    mocks.vitehub.mockReturnValue([
      false,
      [{
        name: "vite-hub/deployment-preset",
        config(config: { nitro?: Record<string, unknown> }) {
          const cloudflare = config.nitro?.cloudflare as Record<string, unknown> | undefined
          const wrangler = cloudflare?.wrangler as Record<string, unknown> | undefined
          config.nitro = {
            ...config.nitro,
            cloudflare: {
              ...cloudflare,
              wrangler: {
                ...wrangler,
                name: "vitehub-nuxt",
              },
            },
            preset: "cloudflare_module",
          }
          ;(config as Record<string, unknown>).queue = {
            namePrefix: "vitehub-nuxt-",
          }
        },
      }],
      {
        name: "@vite-hub/agent/vite",
        config: mocks.agentHook,
        vitehub: {
          agent: {
            transformWorkflowRegistry: mocks.agentWorkflowRegistryTransform,
          },
        },
      },
      {
        name: "@vite-hub/queue/vite",
        config: vi.fn(),
        vitehub: {
          queue: {
            createNitroConfig: mocks.queueNitroConfig,
          },
        },
      },
      {
        name: "@vite-hub/sandbox/vite",
        config: mocks.sandboxHook,
      },
      {
        name: "@vite-hub/workflow/vite",
        vitehub: {
          workflow: {
            createNitroConfig: mocks.workflowNitroConfig,
          },
        },
      },
      {
        name: "vite-hub/object-hook",
        config: {
          handler: mocks.objectHook,
        },
      },
      {
        name: "vite-hub/deployment-output",
        enforce: "post",
        config: mocks.outputHook,
        vitehub: {
          deploymentOutput: {
            useEnvPlugin: mocks.useEnvPlugin,
          },
        },
      },
      {
        name: "@vite-hub/env/vite",
        api: {
          resolveProjectRoot: vi.fn((root: string) => {
            const envOptions = (mocks.vitehub.mock.calls.at(-1)?.[0] as {
              env?: { projectRoot?: string }
            } | undefined)?.env
            return envOptions?.projectRoot ? resolve(root, envOptions.projectRoot) : resolveViteHubProjectRoot(root)
          }),
        },
        config: mocks.envHook,
      },
    ])
  })

  it("installs flattened ViteHub plugins and applies their config hooks to Nitro", async () => {
    const existingPlugin = {
      name: "vite-hub/object-hook",
      config: {
        handler: mocks.objectHook,
      },
    }
    const existingQueuePlugin = {
      name: "@vite-hub/queue/vite",
      config: mocks.existingQueueConfig,
      vitehub: {
        queue: {
          createNitroConfig: mocks.existingQueueNitroConfig,
        },
      },
    }
    const existingOwnerPlugin = {
      name: "@vite-hub/auth/vite",
      config: mocks.existingOwnerConfig,
    }
    const { nuxt, runNitroConfigHook } = createNuxt(true, [[
      existingQueuePlugin,
      existingOwnerPlugin,
      existingPlugin,
      { name: "vite-hub/deployment-output" },
    ]])
    mocks.outputHook.mockImplementationOnce((config: { nitro?: Record<string, unknown> }) => {
      if (!(config as Record<string, unknown>).envReady) return
      const cloudflare = config.nitro?.cloudflare as Record<string, unknown> | undefined
      const wrangler = cloudflare?.wrangler as Record<string, unknown> | undefined
      config.nitro = {
        ...config.nitro,
        cloudflare: {
          ...cloudflare,
          wrangler: {
            ...wrangler,
            secrets: { required: ["VITEHUB_TOKEN"] },
          },
        },
      }
    })

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect((nuxt.options.vite as typeof nuxt.options.vite & {
      [VITEHUB_GENERATED_ROOT]?: string
    })[VITEHUB_GENERATED_ROOT]).toBe("/tmp/vitehub-nuxt/.nuxt/vitehub")
    expect((nuxt.options.vite as typeof nuxt.options.vite & {
      [VITEHUB_SERVER_DIRS]?: string[]
    })[VITEHUB_SERVER_DIRS]).toEqual(["/tmp/vitehub-nuxt/custom-server"])
    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toEqual([
      expect.objectContaining({ name: "vite-hub/deployment-preset" }),
      expect.objectContaining({ name: "@vite-hub/agent/vite" }),
      expect.objectContaining({ name: "@vite-hub/sandbox/vite" }),
      expect.objectContaining({ name: "@vite-hub/workflow/vite" }),
      expect.objectContaining({ name: "@vite-hub/env/vite" }),
      existingQueuePlugin,
      existingOwnerPlugin,
      existingPlugin,
    ])

    const d1Binding = {
      binding: "DB",
      database_id: "database-id",
      database_name: "database-name",
    }
    const nitroConfig = {
      cloudflare: {
        wrangler: {
          d1_databases: [d1Binding, d1Binding],
          observability: { enabled: true },
        },
      },
    }
    await runNitroConfigHook(nitroConfig)

    expect(mocks.existingQueueConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { namePrefix: "vitehub-nuxt-" },
      }),
      expect.anything(),
    )
    expect(mocks.existingQueueNitroConfig).toHaveBeenCalledWith({
      development: true,
      nitro: expect.objectContaining({ preset: "cloudflare_module" }),
      projectRoot: "/tmp/vitehub-nuxt",
      root: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    expect(mocks.workflowNitroConfig).toHaveBeenCalledWith({
      nitro: expect.objectContaining({ preset: "cloudflare_module" }),
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
      transformRegistry: mocks.agentWorkflowRegistryTransform,
    })
    expect(mocks.queueNitroConfig).not.toHaveBeenCalled()
    expect(mocks.existingOwnerConfig).toHaveBeenCalledOnce()
    expect(mocks.agentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_GENERATED_ROOT]: "/tmp/vitehub-nuxt/.nuxt/vitehub",
        [VITEHUB_SERVER_DIRS]: ["/tmp/vitehub-nuxt/custom-server"],
      }),
      expect.anything(),
    )
    expect(mocks.sandboxHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
      }),
      expect.anything(),
    )
    expect(mocks.objectHook).toHaveBeenCalledWith(
      expect.objectContaining({
        nitro: expect.objectContaining({ preset: "cloudflare_module" }),
        resolve: {
          alias: {
            "#vitehub/env/public": "/tmp/vitehub-nuxt/.vitehub/env/public.mjs",
            "#vitehub/env/server": "/tmp/vitehub-nuxt/.vitehub/env/server.mjs",
            "#vitehub/templates": "/tmp/vitehub-nuxt/.vitehub/markdown-template/templates.mjs",
            "~": "/tmp/vitehub-nuxt/app",
          },
        },
        root: "/tmp/vitehub-nuxt",
      }),
      {
        command: "serve",
        isPreview: false,
        isSsrBuild: true,
        mode: "development",
      },
    )
    expect(mocks.outputHook).toHaveBeenCalledOnce()
    expect(mocks.envHook).toHaveBeenCalledOnce()
    expect(mocks.useEnvPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ name: "@vite-hub/env/vite" }),
    )
    expect(nitroConfig).toEqual({
      alias: {
        "#vitehub/env/public": "/tmp/vitehub-nuxt/.vitehub/env/public.mjs",
        "#vitehub/env/server": "/tmp/vitehub-nuxt/.vitehub/env/server.mjs",
        "#vitehub/templates": "/tmp/vitehub-nuxt/.vitehub/markdown-template/templates.mjs",
      },
      cloudflare: {
        wrangler: {
          d1_databases: [d1Binding, d1Binding],
          name: "vitehub-nuxt",
          observability: { enabled: true },
          secrets: { required: ["VITEHUB_TOKEN"] },
        },
      },
      ownerPlugin: true,
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
      modules: ["agent-module"],
      preset: "cloudflare_module",
      queues: {
        handlers: [{ handler: "custom-server/queues/email.ts" }],
      },
      sandbox: true,
      workflows: true,
    })
  })

  it("binds deployment output to an existing Env plugin selected for replay", async () => {
    const existingEnvPlugin = {
      name: "@vite-hub/env/vite",
      api: { resolveProjectRoot: (root: string) => resolveViteHubProjectRoot(root) },
      config: vi.fn(),
    }
    const { nuxt } = createNuxt(false, [existingEnvPlugin])

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect(mocks.useEnvPlugin).toHaveBeenCalledWith(existingEnvPlugin)
    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toContain(existingEnvPlugin)
  })

  it("replays configured Nuxt Vite options into Nitro hooks", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.vite, {
      root: "/tmp/vitehub-nuxt/custom-vite-root",
      workspace: false,
    })

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)
    await runNitroConfigHook({})

    expect(mocks.agentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/vitehub-nuxt/custom-vite-root",
        workspace: false,
      }),
      expect.anything(),
    )
  })

  it("finalizes deployment output after later ViteHub post hooks", async () => {
    const lateCloudflarePlugin = {
      name: "vite-hub/custom-cloudflare",
      enforce: "post" as const,
      config() {
        return {
          nitro: {
            cloudflare: {
              wrangler: {
                env: { staging: { name: "staging-worker" } },
              },
            },
          },
        }
      },
    }
    const { nuxt, runNitroConfigHook } = createNuxt(false, [lateCloudflarePlugin])

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)
    await runNitroConfigHook({})

    expect(mocks.outputHook).toHaveBeenCalledWith(
      expect.objectContaining({
        nitro: expect.objectContaining({
          cloudflare: expect.objectContaining({
            wrangler: expect.objectContaining({ env: { staging: { name: "staging-worker" } } }),
          }),
        }),
      }),
      expect.anything(),
    )
  })

  it("adds generated and Cloudflare types to Nuxt and Nitro", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect(nuxt.options).toMatchObject({
      nitro: {
        typescript: {
          tsConfig: {
            include: ["../.vitehub/types.d.ts", expect.stringContaining("cloudflare-types.d.ts")],
          },
        },
      },
      typescript: {
        tsConfig: {
          include: ["../.vitehub/types.d.ts", expect.stringContaining("cloudflare-types.d.ts")],
        },
      },
    })
  })

  it("exposes materialized Email templates to Nuxt and Nitro on Vercel", async () => {
    mocks.vitehub.mockReturnValue([{
      api: { prepareTypes: vi.fn() },
      name: "@vite-hub/email/vite",
    }])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ email: true, preset: "vercel" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    const emailTemplates = "/tmp/vitehub-nuxt/.vitehub/email/templates"
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    expect(((nuxt.options as typeof nuxt.options & { nitro: { alias: Record<string, string> } }).nitro).alias["#vitehub/emails"]).toBe(emailTemplates)
    expect((nitroConfig.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
  })

  it("materializes Email templates before Cloudflare Workflow preparation", async () => {
    const prepareTypes = vi.fn().mockResolvedValue({
      "monthly-recap": "/tmp/vitehub-nuxt/.vitehub/email/templates/monthly-recap.mjs",
      "monthly-recap/detail": "/tmp/vitehub-nuxt/.vitehub/email/templates/monthly-recap%2Fdetail.mjs",
    })
    mocks.vitehub.mockReturnValue([{
      api: { prepareTypes },
      name: "@vite-hub/email/vite",
    }])
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ email: true, preset: "cloudflare" }, nuxt)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    const emailTemplates = "/tmp/vitehub-nuxt/.vitehub/email/templates"
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails/monthly-recap"])
      .toBe(`${emailTemplates}/monthly-recap.mjs`)
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails/monthly-recap/detail"])
      .toBe(`${emailTemplates}/monthly-recap%2Fdetail.mjs`)
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    expect(((nuxt.options as typeof nuxt.options & { nitro: { alias: Record<string, string> } }).nitro).alias["#vitehub/emails"]).toBe(emailTemplates)
  })

  it("resolves live-added nested Email templates dynamically during Nuxt development", async () => {
    const prepareTypes = vi.fn().mockResolvedValue({
      monthly: "/tmp/vitehub-nuxt/.vitehub/email/templates/monthly.mjs",
    })
    mocks.vitehub.mockReturnValue([{
      api: { prepareTypes },
      name: "@vite-hub/email/vite",
    }])
    const { nuxt, runNitroConfigHook } = createNuxt(true)

    await viteHubNuxtModule({ email: true, preset: "vercel" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(nuxt.options.alias).not.toHaveProperty("#vitehub/emails/monthly")
    const rollupConfig = nitroConfig.rollupConfig as { plugins: Array<{ name: string, resolveId: (id: string) => string | undefined }> }
    const resolver = rollupConfig.plugins.find(plugin => plugin.name === "vite-hub/nuxt-email-templates")
    expect(resolver?.resolveId("#vitehub/emails/monthly/detail"))
      .toBe("/tmp/vitehub-nuxt/.vitehub/email/templates/monthly%2Fdetail.mjs")
  })

  it("exposes templates from a directly installed Email plugin", async () => {
    const prepareTypes = vi.fn()
    const { nuxt, runNitroConfigHook } = createNuxt(false, [{
      api: { prepareTypes },
      name: "@vite-hub/email/vite",
    }])

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    const emailTemplates = "/tmp/vitehub-nuxt/.vitehub/email/templates"
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    expect((nitroConfig.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
  })

  it("materializes and exposes Email templates on non-host-specific Nitro presets", async () => {
    const prepareTypes = vi.fn()
    mocks.vitehub.mockReturnValue([{
      api: { prepareTypes },
      name: "@vite-hub/email/vite",
    }])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ email: { driver: "unemail/driver/resend" }, preset: "node" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    const emailTemplates = "/tmp/vitehub-nuxt/.vitehub/email/templates"
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    expect((nitroConfig.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
  })

  it("includes generated types from a configured Env project root", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ env: { projectRoot: "apps/api" }, preset: "node" }, nuxt)

    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../apps/api/.vitehub/data/**/*.d.ts"],
        include: ["../.vitehub/types.d.ts", "../apps/api/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("accepts Env declarations under vitehub and installs generated runtime aliases", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    const githubToken = { source: "GITHUB_TOKEN" }

    await viteHubNuxtModule({
      env: {
        projectRoot: "apps/api",
        server: { githubToken },
      },
      preset: "node",
    } as never, nuxt)

    expect(mocks.vitehub).toHaveBeenCalledWith({
      env: { projectRoot: "apps/api" },
      preset: "node",
    })
    expect(nuxt.options.vite).toMatchObject({
      env: { server: { githubToken } },
    })
    expect(nuxt.options.alias).toMatchObject({
      "#vitehub/env/server": "/tmp/vitehub-nuxt/apps/api/.vitehub/env/server.mjs",
      "#vitehub/templates": "/tmp/vitehub-nuxt/.vitehub/markdown-template/templates.mjs",
    })

    const nitroConfig = { alias: { "#vitehub/templates": "./custom-templates.mjs" } }
    await runNitroConfigHook(nitroConfig)
    expect(nitroConfig.alias).toMatchObject({
      "#vitehub/env/server": "/tmp/vitehub-nuxt/apps/api/.vitehub/env/server.mjs",
      "#vitehub/templates": "./custom-templates.mjs",
    })
  })

  it("prepares Env types before collecting generated declarations", async () => {
    const steps: string[] = []
    const prepareEnvTypes = vi.fn(async () => { steps.push("env") })
    const prepareTypes = vi.fn(async () => { steps.push("types") })
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: prepareEnvTypes, resolveProjectRoot: (root: string) => root },
        name: "@vite-hub/env/vite",
      },
      {
        api: { prepareTypes },
        name: "vite-hub/types",
      },
    ])
    const { nuxt } = createNuxt()
    const githubToken = { source: "GITHUB_TOKEN" }
    const appName = { source: "PUBLIC_APP_NAME" }
    ;(nuxt.options.vite as typeof nuxt.options.vite & { env?: Record<string, unknown> }).env = { public: { appName } }

    await viteHubNuxtModule({ env: { server: { githubToken } }, preset: "node" } as never, nuxt)

    expect(prepareEnvTypes).toHaveBeenCalledWith({ public: { appName }, server: { githubToken } }, "/tmp/vitehub-nuxt")
    expect(steps).toEqual(["env", "types"])
  })

  it("removes disabled Email types before collecting generated declarations", async () => {
    const steps: string[] = []
    const cleanupEmailTypes = vi.fn(async () => { steps.push("email") })
    const prepareTypes = vi.fn(async () => { steps.push("types") })
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: cleanupEmailTypes },
        name: "@vite-hub/email/optional-peer-resolver",
      },
      {
        api: { prepareTypes },
        name: "vite-hub/types",
      },
    ])
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ preset: "node" } as never, nuxt)

    expect(cleanupEmailTypes).toHaveBeenCalledWith("/tmp/vitehub-nuxt")
    expect(steps).toEqual(["email", "types"])
  })

  it("replaces existing Env array declarations instead of concatenating data values", async () => {
    const { nuxt } = createNuxt()
    const vite = nuxt.options.vite as typeof nuxt.options.vite & { env?: Record<string, unknown> }
    vite.env = { public: { regions: ["old"] } }

    await viteHubNuxtModule({
      env: { public: { regions: ["new"] } },
      preset: "node",
    } as never, nuxt)

    expect(vite.env).toMatchObject({ public: { regions: ["new"] } })
  })

  it("merges nested Env declaration namespaces without merging declaration leaves", async () => {
    const { nuxt } = createNuxt()
    const vite = nuxt.options.vite as typeof nuxt.options.vite & { env?: Record<string, unknown> }
    vite.env = {
      server: {
        database: {
          password: { source: "OLD_PASSWORD" },
          url: { source: "DATABASE_URL" },
        },
      },
    }

    await viteHubNuxtModule({
      env: { server: { database: { password: { source: "DATABASE_PASSWORD" } } } },
      preset: "node",
    } as never, nuxt)

    expect(vite.env).toMatchObject({
      server: {
        database: {
          password: { source: "DATABASE_PASSWORD" },
          url: { source: "DATABASE_URL" },
        },
      },
    })
  })

  it("preserves Env namespace children named source and kind", async () => {
    const { nuxt } = createNuxt()
    const vite = nuxt.options.vite as typeof nuxt.options.vite & { env?: Record<string, unknown> }
    vite.env = {
      server: {
        service: {
          kind: { source: "SERVICE_KIND" },
          source: { source: "SERVICE_SOURCE" },
        },
      },
    }

    await viteHubNuxtModule({
      env: { server: { service: { token: { source: "SERVICE_TOKEN" } } } },
      preset: "node",
    } as never, nuxt)

    expect(vite.env).toMatchObject({
      server: {
        service: {
          kind: { source: "SERVICE_KIND" },
          source: { source: "SERVICE_SOURCE" },
          token: { source: "SERVICE_TOKEN" },
        },
      },
    })
  })

  it("derives Env aliases from an existing Env Vite plugin", async () => {
    const envPlugin = {
      name: "@vite-hub/env/vite",
      api: {
        resolveProjectRoot: (root: string) => resolve(root, "packages/config"),
      },
    }
    const { nuxt } = createNuxt(false, [envPlugin])

    await viteHubNuxtModule({ preset: "node" }, nuxt)

    expect(nuxt.options.alias).toMatchObject({
      "#vitehub/env/server": "/tmp/vitehub-nuxt/packages/config/.vitehub/env/server.mjs",
    })
  })

  it("keeps Env runtime aliases disabled while retaining Markdown templates", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ env: false, preset: "node" }, nuxt)

    const alias = nuxt.options.alias as Record<string, string>
    expect(alias).not.toHaveProperty("#vitehub/env/server")
    expect(alias["#vitehub/templates"]).toBe("/tmp/vitehub-nuxt/.vitehub/markdown-template/templates.mjs")
  })

  it("includes generated types from every configured integration project root", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({
      channels: { projectRoot: "apps/api" },
      env: { projectRoot: "packages/config" },
      preset: "node",
    }, nuxt)

    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: [
          "../apps/api/.vitehub/data/**/*.d.ts",
          "../packages/config/.vitehub/data/**/*.d.ts",
        ],
        include: [
          "../.vitehub/types.d.ts",
          "../apps/api/.vitehub/**/*.d.ts",
          "../packages/config/.vitehub/**/*.d.ts",
        ],
      },
    })
  })

  it("resolves generated type roots from the effective Vite root", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options.vite, { root: "app" })

    await viteHubNuxtModule({ env: { projectRoot: "packages/config" }, preset: "node" }, nuxt)

    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../app/packages/config/.vitehub/data/**/*.d.ts"],
        include: ["../app/.vitehub/types.d.ts", "../app/packages/config/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("resolves Database generated types from the Nuxt root", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options.vite, { root: "app" })

    await viteHubNuxtModule({ database: { projectRoot: "packages/db" }, preset: "node" }, nuxt)

    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../packages/db/.vitehub/data/**/*.d.ts"],
        include: ["../app/.vitehub/types.d.ts", "../packages/db/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("includes the effective top-level Database project root", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      database: { projectRoot: "packages/db" },
    })

    await viteHubNuxtModule({ database: true, preset: "node" }, nuxt)

    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../packages/db/.vitehub/data/**/*.d.ts"],
        include: ["../.vitehub/types.d.ts", "../packages/db/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("installs the Database Nuxt runtime alias through the framework module", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.vite, {
      root: "/tmp/vitehub-nuxt/custom-vite-root",
    })

    await viteHubNuxtModule({ database: true, preset: "cloudflare" }, nuxt)
    const nitroConfig = {}
    await runNitroConfigHook(nitroConfig)

    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toContainEqual(
      expect.objectContaining({ name: "@vite-hub/database/vite" }),
    )
    expect((nuxt.options.alias as Record<string, string>)["@vite-hub/database/runtime/state"])
      .toBe(databaseRuntimeState)
    expect(nitroConfig).toMatchObject({
      alias: {
        "@vite-hub/database/drizzle": "/tmp/vitehub-nuxt/.vitehub/database/cloudflare-runtime.mjs",
        "@vite-hub/database/runtime/state": databaseRuntimeState,
      },
    })
  })

  it("keeps the Database Nitro runtime alias out of development", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt(true)

    await viteHubNuxtModule({ database: true, preset: "cloudflare" }, nuxt)
    const nitroConfig = {}
    await runNitroConfigHook(nitroConfig)

    expect((nuxt.options.alias as Record<string, string>)["@vite-hub/database/runtime/state"])
      .toBe(databaseRuntimeState)
    expect(nitroConfig).not.toHaveProperty("alias.@vite-hub/database/runtime/state")
  })

  it("preserves an explicitly configured Database runtime alias", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.alias, {
      "@vite-hub/database/runtime/state": "./custom-nuxt-database-state.ts",
    })

    await viteHubNuxtModule({ database: true, preset: "cloudflare" }, nuxt)
    const nitroConfig = {
      alias: {
        "@vite-hub/database/runtime/state": "./custom-database-state.ts",
      },
    }
    await runNitroConfigHook(nitroConfig)

    expect((nuxt.options.alias as Record<string, string>)["@vite-hub/database/runtime/state"])
      .toBe("./custom-nuxt-database-state.ts")
    expect(nitroConfig.alias["@vite-hub/database/runtime/state"]).toBe("./custom-database-state.ts")
  })

  it("installs the Auth Vue and server runtime integration through the framework module", async () => {
    const { nitroConfigHooks, nuxt } = createNuxt()

    await viteHubNuxtModule({ auth: true, preset: "cloudflare" }, nuxt)

    const options = nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string, name: string }> }
      nitro: { alias: Record<string, string>, plugins: string[] }
    }
    expect(options.imports.imports).toEqual([
      { from: "vite-hub/source/client", name: "useCollection" },
      { from: "vite-hub/auth/vue", name: "useAuthClient" },
      { from: "vite-hub/auth/vue", name: "useSession" },
      { from: "vite-hub/auth/vue", name: "useSignIn" },
      { from: "vite-hub/auth/vue", name: "useSignUp" },
      { from: "vite-hub/auth/vue", name: "useUserSession" },
    ])
    expect(options.nitro.alias["#vitehub/env/server"]).toBe("/tmp/vitehub-nuxt/.vitehub/env/server.mjs")
    expect(options.nitro.plugins).toHaveLength(1)
    expect(options.nitro.plugins[0]).toMatch(/\/runtime\/nuxt\.js$/)
    expect(nitroConfigHooks).toHaveLength(1)
  })

  it("auto-imports Agent Vue clients only when Agent Definitions are enabled", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ agent: true, preset: "cloudflare" }, nuxt)

    expect((nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string, name: string }> }
    }).imports.imports).toEqual([
      { from: "vite-hub/agent/vue", name: "useAgent" },
      { from: "vite-hub/agent/vue", name: "useAgentInvocation" },
      { from: "vite-hub/agent/vue", name: "useAgentInvocations" },
      { from: "vite-hub/agent/vue", name: "useChat" },
      { from: "vite-hub/source/client", name: "useCollection" },
    ])
  })

  it("rejects a configured Nuxt composable that would bind a different useChat", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      imports: { imports: [{ from: "@ai-sdk/vue", name: "useChat" }] },
    })

    await expect(viteHubNuxtModule({ agent: true, preset: "cloudflare" }, nuxt))
      .rejects.toThrow("Cannot auto-import useChat from vite-hub/agent/vue because it is already configured from @ai-sdk/vue")
  })

  it("checks Nuxt composable collisions against their exposed aliases", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      imports: { imports: [{ as: "useAiChat", from: "@ai-sdk/vue", name: "useChat" }] },
    })

    await viteHubNuxtModule({ agent: true, preset: "cloudflare" }, nuxt)
    expect((nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ as?: string, from: string, name: string }> }
    }).imports.imports).toContainEqual({ from: "vite-hub/agent/vue", name: "useChat" })

    const { nuxt: conflictingNuxt } = createNuxt()
    Object.assign(conflictingNuxt.options, {
      imports: { imports: [{ as: "useChat", from: "custom-chat", name: "chat" }] },
    })
    await expect(viteHubNuxtModule({ agent: true, preset: "cloudflare" }, conflictingNuxt))
      .rejects.toThrow("Cannot auto-import useChat from vite-hub/agent/vue because it is already configured from custom-chat")
  })

  it("auto-imports Realtime definition and Vue helpers", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ preset: "cloudflare", realtime: true }, nuxt)

    const imports = (nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string, name: string }> }
    }).imports.imports
    expect(imports).toContainEqual({
      from: "vite-hub/realtime",
      name: "defineRealtime",
    })
    expect(imports).toContainEqual({
      from: "vite-hub/realtime/vue",
      name: "useRealtimeTiptap",
    })
  })

  it("does not resolve a relative Vite root twice for Auth Env imports", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options.vite, { root: "app" })

    await viteHubNuxtModule({ auth: true, preset: "cloudflare" }, nuxt)

    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe(resolve(".vitehub/env/server.mjs"))
  })

  it("keeps Auth composables without Env runtime wiring", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ auth: true, env: false, preset: "cloudflare" }, nuxt)

    const options = nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string, name: string }> }
      nitro: Record<string, unknown>
    }
    expect(options.imports.imports).toHaveLength(6)
    expect(options.alias).not.toHaveProperty("#vitehub/env/server")
    expect(options.nitro.alias).toEqual({
      "#vitehub/templates": "/tmp/vitehub-nuxt/.vitehub/markdown-template/templates.mjs",
    })
    expect(options.nitro).not.toHaveProperty("plugins")
  })

  it("does not concatenate complete Nitro arrays returned by config hooks", async () => {
    mocks.vitehub.mockReturnValue([
      {
        name: "vite-hub/first",
        config: () => ({
          nitro: {
            modules: ["first"],
          },
        }),
      },
      {
        name: "vite-hub/second",
        config: (config: { nitro?: Record<string, unknown> }) => ({
          nitro: {
            ...config.nitro,
            modules: [...((config.nitro?.modules as string[] | undefined) ?? []), "second"],
          },
        }),
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()
    const nitroConfig = {}

    await viteHubNuxtModule({ preset: "node" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect(nitroConfig).toMatchObject({
      modules: ["first", "second"],
    })
  })

  it("does nothing when Nuxt has not initialized", async () => {
    await expect(viteHubNuxtModule({ preset: "node" })).resolves.toBeUndefined()
    expect(mocks.vitehub).not.toHaveBeenCalled()
  })

  it("merges top-level Nuxt options with inline module options", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      vitehub: {
        agent: true,
        preset: "node",
      },
    })

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect(mocks.vitehub).toHaveBeenCalledWith({
      agent: true,
      preset: "cloudflare",
    })
  })

  it("exposes Nuxt module metadata for vitehub configuration", () => {
    expect(viteHubNuxtModule.getMeta()).toEqual({
      configKey: "vitehub",
      name: "vite-hub/nuxt",
    })
  })
})
