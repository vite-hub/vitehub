import { describe, expect, it, vi } from "vitest"

import { hubEnv } from "@vite-hub/env/vite"

import hubAuthNuxt from "../src/nuxt.ts"

function createNuxt() {
  const hooks: Array<(config: Record<string, unknown>) => Promise<void>> = []
  return {
    hook(name: "nitro:config", handler: (config: Record<string, unknown>) => Promise<void>) {
      expect(name).toBe("nitro:config")
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
      rootDir: "/tmp/vitehub-auth-nuxt",
    },
  }
}

describe("Auth Nuxt integration", () => {
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
      "#vitehub/env/public": "/tmp/vitehub-auth-nuxt/.vitehub/env/public.mjs",
      "#vitehub/env/server": "/tmp/vitehub-auth-nuxt/.vitehub/env/server.mjs",
    })
    expect(nuxt.options.nitro.alias).toEqual({
      "#nitro-existing": "/tmp/nitro-existing.mjs",
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
    expect(nuxt.hooks).toHaveLength(1)
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
    await nuxt.hooks[0]({})
    expect(authConfig).toHaveBeenCalledWith(expect.objectContaining({ root: "/tmp/vite-root" }), expect.anything())
    expect(nuxt.hooks).toHaveLength(1)
  })

  it("resolves relative Env roots from the Vite root", () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { root: string } }).vite = { root: "/tmp/workspace/apps/site" }

    hubAuthNuxt({ env: { projectRoot: "../shared" } }, nuxt)

    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe("/tmp/workspace/apps/shared/.vitehub/env/server.mjs")
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

  it("preserves the Vite Auth switch during Nitro replay", async () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { auth: false } }).vite = { auth: false }

    hubAuthNuxt({}, nuxt)

    const plugins = (nuxt.options as typeof nuxt.options & { vite: { plugins: Array<{ config?: (config: { auth?: false }) => unknown, name?: string }> } }).vite.plugins
    const authPlugin = plugins.find(plugin => plugin.name === "@vite-hub/auth/vite")!
    const authConfig = vi.fn(() => ({ nitro: {} }))
    authPlugin.config = authConfig
    await nuxt.hooks[0]({})
    expect(authConfig).toHaveBeenCalledWith(expect.objectContaining({ auth: false }), expect.anything())
  })

  it("does nothing before Nuxt initializes", () => {
    expect(hubAuthNuxt()).toBeUndefined()
  })
})
