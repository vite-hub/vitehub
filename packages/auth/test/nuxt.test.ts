import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { hubEnv } from "@vite-hub/env/vite"

import hubAuthNuxt from "../src/nuxt.ts"

function createNuxt() {
  const hooks: Array<((config: Record<string, unknown>) => Promise<void>) | (() => void)> = []
  return {
    hook(name: "modules:done" | "nitro:config", handler: ((config: Record<string, unknown>) => Promise<void>) | (() => void)) {
      hooks.push(handler)
    },
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
      { from: "vite-hub/auth/vue", name: "useAuthClient" },
      { from: "vite-hub/auth/vue", name: "useSignIn" },
      { from: "vite-hub/auth/vue", name: "useSignUp" },
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
    // nitro:config, modules:done, and prepare:types for the definePageMeta({ auth }) type.
    expect(nuxt.hooks).toHaveLength(3)
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
    expect(options.imports.imports).toHaveLength(5)
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
    // nitro:config, modules:done, and prepare:types for the definePageMeta({ auth }) type.
    expect(nuxt.hooks).toHaveLength(3)
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
