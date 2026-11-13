import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { hubEnv } from "@vite-hub/env/vite"

import hubAuthNuxt from "../src/nuxt.ts"

function createNuxt() {
  const hooks: Array<((config: Record<string, unknown>) => Promise<void>) | (() => void)> = []
  const hookNames: string[] = []
  return {
    hook(name: "modules:done" | "nitro:config", handler: ((config: Record<string, unknown>) => Promise<void>) | (() => void)) {
      hooks.push(handler)
      hookNames.push(name)
    },
    hookNames,
    hooks,
    options: {
      alias: { "#existing": "/tmp/existing.mjs" },
      imports: {
        imports: [{ from: "app/composables", name: "useSession" }],
      },
      nitro: {
        alias: { "#nitro-existing": "/tmp/nitro-existing.mjs" },
        plugins: ["/tmp/existing-plugin.mjs"],
      },
      plugins: [] as Array<string | { src: string, order?: number }>,
      rootDir: "/tmp/vitehub-auth-nuxt",
    },
  }
}

describe("Auth Nuxt integration", () => {
  it("installs the Vue context bridge before existing Nuxt plugins", () => {
    const nuxt = createNuxt()
    nuxt.options.plugins = ["/tmp/user-plugin.mjs"]

    hubAuthNuxt({ env: false }, nuxt)

    expect(nuxt.options.plugins?.[0]).toMatchObject({ order: -1 })
    expect(nuxt.options.plugins?.[0]).toMatchObject({ src: expect.stringMatching(/\/runtime\/vue-nuxt\.js$/) })
    expect(nuxt.options.plugins?.[1]).toBe("/tmp/user-plugin.mjs")

    nuxt.options.plugins.unshift("/tmp/later-module-plugin.mjs")
    nuxt.hooks[1]({} as never)
    expect(nuxt.options.plugins?.[0]).toMatchObject({ order: -1 })
  })
  it("passes the page guard redirects to the app and types definePageMeta({ auth })", () => {
    const hooks = new Map<string, (input: { declarations: string[] }) => void>()
    const nuxt = { ...createNuxt(), hook: (name: string, handler: (input: { declarations: string[] }) => void) => hooks.set(name, handler) }
    hubAuthNuxt({ env: false, auth: { redirects: { login: "/sign-in" } } }, nuxt as never)
    expect((nuxt.options as { runtimeConfig?: unknown }).runtimeConfig).toEqual({ public: { vitehubAuth: { basePath: "/api/auth", redirects: { login: "/sign-in", guest: "/" } } } })
    const declarations: string[] = []
    hooks.get("prepare:types")?.({ declarations })
    expect(declarations.join("\n")).toContain('auth?: import("@vite-hub/auth/nuxt").AuthPageMeta')
  })

  it("links the definePageMeta({ auth }) type to the docs page that explains the page guard", async () => {
    const hooks = new Map<string, (input: { declarations: string[] }) => void>()
    const nuxt = { ...createNuxt(), hook: (name: string, handler: (input: { declarations: string[] }) => void) => hooks.set(name, handler) }
    hubAuthNuxt({ env: false }, nuxt as never)
    const declarations: string[] = []
    hooks.get("prepare:types")?.({ declarations })

    const path = /https:\/\/vitehub\.dev(\/docs\/[\w/-]+)/.exec(declarations.join("\n"))?.[1]
    expect(path).toBe("/docs/auth/protect-pages")
    const page = await readFile(new URL(`../../../docs/content${path}.md`, import.meta.url), "utf8")
    expect(page).toContain("definePageMeta({ auth: 'user' })")
    expect(page).toContain("definePageMeta({ auth: 'guest' })")
  })

  it("removes Better Auth's client from the prefetch hints of every page", () => {
    type Manifest = Record<string, { isEntry?: boolean, dynamicImports?: string[] }>
    const hooks = new Map<string, (manifest: Manifest) => void>()
    const nuxt = { ...createNuxt(), hook: (name: string, handler: (manifest: Manifest) => void) => hooks.set(name, handler) }
    const root = "/tmp/vitehub-auth-nuxt/app"
    hubAuthNuxt({ env: false }, { ...nuxt, options: { ...nuxt.options, srcDir: "/tmp/vitehub-auth-nuxt/other", vite: { root } } } as never)
    // Vite writes manifest keys relative to its root, from the real path of each module.
    const client = relative(root, realpathSync(fileURLToPath(import.meta.resolve("better-auth/vue"))))
    const manifest: Manifest = {
      "entry.js": { isEntry: true, dynamicImports: [client, "pages/index.vue"] },
      [client]: {},
      "pages/index.vue": { dynamicImports: [client] },
    }

    hooks.get("build:manifest")?.(manifest)

    expect(manifest).toEqual({
      "entry.js": { isEntry: true, dynamicImports: ["pages/index.vue"] },
      [client]: {},
      "pages/index.vue": { dynamicImports: [] },
    })
  })

  it.each([false, { redirects: { login: "/module-login", guest: "/module-home" } }] as const)("uses module Auth options and ignores top-level Vite Auth %j", (auth) => {
    const nuxt = { options: { rootDir: "/tmp/vitehub-auth-nuxt", vite: { root: "/tmp/vitehub-auth-nuxt", auth: { redirects: { login: "/sign-in", guest: "/home" } } }, runtimeConfig: {} } }

    hubAuthNuxt({ env: false, auth }, nuxt)

    expect(nuxt.options.runtimeConfig).toEqual({ public: { vitehubAuth: auth === false ? false : { basePath: "/api/auth", redirects: auth.redirects } } })
  })

  it("disables the session bridge and guard through module Auth options", () => {
    const nuxt = { options: { rootDir: "/tmp/vitehub-auth-nuxt", runtimeConfig: {} } }

    hubAuthNuxt({ env: false, auth: false }, nuxt)

    expect(nuxt.options.runtimeConfig).toEqual({ public: { vitehubAuth: false } })
  })

  it("registers the Env resolver for the generated Auth Definition", async () => {
    const runtime = await readFile(new URL("../src/runtime/nuxt.ts", import.meta.url), "utf8")

    expect(runtime).toContain('import definition from "#vitehub/auth/definition"')
    expect(runtime).toContain("setAuthRuntimeEnvResolver(useServerEnv, definition)")
  })

  it("installs Vue composables and the server Env runtime once", () => {
    const nuxt = createNuxt()

    hubAuthNuxt({ importsFrom: "vite-hub/auth/vue" }, nuxt)
    hubAuthNuxt({ importsFrom: "vite-hub/auth/vue" }, nuxt)
    const vite = (nuxt.options as typeof nuxt.options & {
      vite: { plugins: Array<{ name?: string }> }
    }).vite

    expect(nuxt.options.imports.imports).toEqual([
      { from: "app/composables", name: "useSession" },
      { from: "vite-hub/auth/vue", name: "useAbility" },
      { from: "vite-hub/auth/vue", name: "useAuthClient" },
      { from: "vite-hub/auth/vue", name: "useUserSession" },
    ])
    expect(nuxt.options.alias).toEqual({
      "#existing": "/tmp/existing.mjs",
      "#vitehub/env/description": "/tmp/vitehub-auth-nuxt/.vitehub/env/description.mjs",
      "#vitehub/env/public": "/tmp/vitehub-auth-nuxt/.vitehub/env/public.mjs",
      "#vitehub/env/server": "/tmp/vitehub-auth-nuxt/.vitehub/env/server.mjs",
    })
    expect(nuxt.options.nitro.alias).toEqual({
      "#nitro-existing": "/tmp/nitro-existing.mjs",
      "#vitehub/env/description": "/tmp/vitehub-auth-nuxt/.vitehub/env/description.mjs",
      "#vitehub/env/public": "/tmp/vitehub-auth-nuxt/.vitehub/env/public.mjs",
      "#vitehub/env/server": "/tmp/vitehub-auth-nuxt/.vitehub/env/server.mjs",
    })
    expect(nuxt.options.nitro.plugins).toHaveLength(2)
    expect(nuxt.options.nitro.plugins[1]).toMatch(/\/runtime\/nuxt\.js$/)
    expect(vite.plugins).toHaveLength(2)
    expect(vite.plugins).toEqual([
      expect.objectContaining({ name: "@vite-hub/env/vite" }),
      expect.objectContaining({ name: "@vite-hub/auth/vite" }),
    ])
    // nitro:config, modules:done, prepare:types for the definePageMeta({ auth }) type, and build:manifest. The app has no abilities, so no <Can>.
    expect(nuxt.hookNames).toEqual(["nitro:config", "modules:done", "prepare:types", "build:manifest"])
  })

  /** Runs the module on a temporary app with an Auth Definition, and returns the components that it registers. */
  async function registeredComponents(files: Record<string, string>, options: Parameters<typeof hubAuthNuxt>[0] = {}, existing: Array<Record<string, unknown>> = []) {
    const root = await mkdtemp(join(tmpdir(), "vitehub-auth-nuxt-components-"))
    try {
      for (const [path, contents] of Object.entries({ "server/auth.ts": "export default defineAuth({})\n", ...files })) {
        await mkdir(join(root, path, ".."), { recursive: true })
        await writeFile(join(root, path), contents)
      }
      const hooks = new Map<string, (components: Array<Record<string, unknown>>) => void>()
      const nuxt = { hook: (name: string, handler: (components: Array<Record<string, unknown>>) => void) => hooks.set(name, handler), options: { rootDir: root } }
      hubAuthNuxt({ env: false, importsFrom: "vite-hub/auth/vue", ...options }, nuxt as never)
      const components = [...existing]
      hooks.get("components:extend")?.(components)
      return { components, hooks: [...hooks.keys()] }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  it("registers no <Can> when the app has no abilities", async () => {
    const { components, hooks } = await registeredComponents({})
    expect(hooks).not.toContain("components:extend")
    expect(components).toEqual([])
  })

  it("registers no <Can> when Auth is off, even with abilities", async () => {
    const { components } = await registeredComponents({ "shared/abilities.ts": "export default {}\n" }, { auth: false })
    expect(components).toEqual([])
  })

  it("registers <Can> and <Cannot> from the Vue entry when the app has abilities, unless the app has its own component", async () => {
    const component = (name: string) => ({
      chunkName: `components/${name.toLowerCase()}`,
      export: name,
      filePath: "vite-hub/auth/vue",
      global: false,
      kebabName: name.toLowerCase(),
      meta: {},
      mode: "all",
      pascalName: name,
      prefetch: false,
      preload: false,
      priority: 0,
      shortPath: "vite-hub/auth/vue",
    })
    const { components } = await registeredComponents({ "shared/abilities.ts": "export default {}\n" })
    expect(components).toEqual([component("Can"), component("Cannot")])

    const own = { pascalName: "Can", filePath: "/app/components/Can.vue" }
    expect((await registeredComponents({ "shared/abilities.ts": "export default {}\n" }, {}, [own])).components).toEqual([own, component("Cannot")])
  })

  // Each pair of names is what Nuxt gives `Can.vue` in a components directory with the same prefix,
  // `components: [{ path, prefix }]`.
  it.each([
    ["Auth", "AuthCan", "auth-can"],
    ["auth", "AuthCan", "auth-can"],
    ["my-auth", "MyAuthCan", "my-auth-can"],
    ["UI", "UICan", "ui-can"],
    ["MonÉquipe", "MonÉquipeCan", "mon-équipe-can"],
    // Letters without case.
    ["日本", "日本Can", "日本-can"],
    // A combining mark: `e` followed by U+0301.
    ["équipe", "ÉquipeCan", "équipe-can"],
  ])("registers <Can> under the prefix %j as %s", async (prefix, pascalName, kebabName) => {
    const own = { pascalName: "Can", filePath: "/app/components/Can.vue" }
    const { components } = await registeredComponents({ "shared/abilities.ts": "export default {}\n" }, { auth: { components: { prefix } } }, [own])
    // The export stays `Can`, so the generated component types read `typeof import("vite-hub/auth/vue")["Can"]`.
    expect(components).toEqual([
      own,
      expect.objectContaining({ chunkName: `components/${kebabName}`, export: "Can", filePath: "vite-hub/auth/vue", kebabName, pascalName }),
      expect.objectContaining({ chunkName: `components/${kebabName}not`, export: "Cannot", filePath: "vite-hub/auth/vue", kebabName: `${kebabName}not`, pascalName: `${pascalName}not` }),
    ])
  })

  it("restarts Nuxt when app or layer abilities are added or removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-auth-nuxt-watch-"))
    try {
      const hooks = new Map<string, (event: string, path: string) => Promise<void>>()
      const nuxt = {
        callHook: vi.fn(async (_name: "restart") => {}),
        hook: (name: string, handler: (event: string, path: string) => Promise<void>) => hooks.set(name, handler),
        options: {
          dev: true,
          rootDir: root,
          _layers: [{ cwd: join(root, "layers/base"), config: { rootDir: join(root, "layers/base") } }],
        },
      }
      hubAuthNuxt({ env: false }, nuxt as never)
      expect(Reflect.get(nuxt.options, "watch")).toEqual([join(root, "shared"), join(root, "layers/base/shared")])
      const watch = hooks.get("builder:watch")!
      await watch("change", "shared/abilities.ts")
      await watch("add", "shared/other.ts")
      expect(nuxt.callHook).not.toHaveBeenCalled()

      await watch("add", "shared/abilities.ts")
      await watch("unlink", join(root, "layers/base/shared/abilities.mjs"))
      expect(nuxt.callHook.mock.calls).toEqual([["restart"], ["restart"]])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps Auth enabled when Env is disabled", () => {
    const nuxt = {
      options: {
        rootDir: "/tmp/vitehub-auth-nuxt",
      },
    }

    hubAuthNuxt({ env: false }, nuxt)
    const options = nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string, name: string }> }
      vite: { plugins: Array<{ name?: string }> }
    }

    expect(options.vite.plugins).toContainEqual(
      expect.objectContaining({ name: "@vite-hub/auth/vite" }),
    )
    expect(options.imports.imports).toHaveLength(4)
    expect(options).not.toHaveProperty("alias")
    expect(options).not.toHaveProperty("nitro")
  })

  it("uses the configured roots for Auth discovery and Env imports", async () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { root: string } }).vite = { root: "/tmp/vite-root" }

    hubAuthNuxt({ env: { projectRoot: "/tmp/env-root" } }, nuxt)

    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe("/tmp/env-root/.vitehub/env/server.mjs")
    const plugins = (nuxt.options as typeof nuxt.options & { vite: { plugins: Array<{ config?: (config: { root?: string }) => unknown, name?: string }> } }).vite.plugins
    expect(plugins).toHaveLength(2)
    const authPlugin = plugins.find(plugin => plugin.name === "@vite-hub/auth/vite")!
    const authConfig = vi.fn(() => ({ nitro: {} }))
    authPlugin.config = authConfig
    await (nuxt.hooks[0] as (config: Record<string, unknown>) => Promise<void>)({})
    expect(authConfig).toHaveBeenCalledWith(expect.objectContaining({ root: "/tmp/vite-root" }), expect.anything())
    // nitro:config, modules:done, prepare:types for the definePageMeta({ auth }) type, and build:manifest. The app has no abilities, so no <Can>.
    expect(nuxt.hooks).toHaveLength(4)
  })

  it("resolves relative Env roots from the Vite root", () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { root: string } }).vite = { root: "/tmp/workspace/apps/site" }

    hubAuthNuxt({ env: { projectRoot: "../shared" } }, nuxt)

    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe("/tmp/workspace/apps/shared/.vitehub/env/server.mjs")
  })

  it("preserves automatic Env project-root detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-auth-nuxt-root-"))
    const appRoot = join(root, "app")
    await mkdir(appRoot)
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "auth-nuxt-root" }))
    try {
      const nuxt = createNuxt()
      ;(nuxt.options as typeof nuxt.options & { vite: { root: string } }).vite = { root: appRoot }

      hubAuthNuxt({}, nuxt)

      expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe(join(root, ".vitehub/env/server.mjs"))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("reuses the installed Env plugin project root", () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { plugins: unknown[], root: string } }).vite = {
      plugins: [hubEnv({ projectRoot: "../shared" })],
      root: "/tmp/workspace/apps/site",
    }

    hubAuthNuxt({}, nuxt)

    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe("/tmp/workspace/apps/shared/.vitehub/env/server.mjs")
  })

  it("validates an explicit Env root against the installed plugin", () => {
    function createNuxtWithEnv() {
      const nuxt = createNuxt()
      ;(nuxt.options as typeof nuxt.options & { vite: { plugins: unknown[], root: string } }).vite = {
        plugins: [hubEnv({ projectRoot: "../shared" })],
        root: "/tmp/workspace/apps/site",
      }
      return nuxt
    }

    expect(() => hubAuthNuxt({ env: { projectRoot: "../shared" } }, createNuxtWithEnv())).not.toThrow()
    expect(() => hubAuthNuxt({ env: { projectRoot: "../other" } }, createNuxtWithEnv())).toThrow(
      "env.projectRoot must match the installed `@vite-hub/env/vite` plugin",
    )
  })

  it("ignores the top-level Vite Auth switch during Nitro replay", async () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { auth: false } }).vite = { auth: false }

    hubAuthNuxt({}, nuxt)

    const plugins = (nuxt.options as typeof nuxt.options & { vite: { plugins: Array<{ config?: (config: { auth?: false }) => unknown, name?: string }> } }).vite.plugins
    const authPlugin = plugins.find(plugin => plugin.name === "@vite-hub/auth/vite")!
    const authConfig = vi.fn(() => ({ nitro: {} }))
    authPlugin.config = authConfig
    await (nuxt.hooks[0] as (config: Record<string, unknown>) => Promise<void>)({})
    expect(authConfig).toHaveBeenCalledWith(expect.not.objectContaining({ auth: false }), expect.anything())
  })

  it("does nothing before Nuxt initializes", () => {
    expect(hubAuthNuxt()).toBeUndefined()
  })
})
