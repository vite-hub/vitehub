import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { cloudflareWorkersDevShimSource } from "../src/cloudflare-workers-dev-shim.injected.ts"
import { viteHubPackagePath, vitestInlinePlugin } from "../src/vitest-inline.ts"

import type { Plugin, PluginOption } from "vite"

async function flatten(options: PluginOption[]): Promise<Plugin[]> {
  const plugins: Plugin[] = []
  for (const option of options) {
    const value = await option
    if (Array.isArray(value)) plugins.push(...await flatten(value))
    else if (value) plugins.push(value as Plugin)
  }
  return plugins
}

function configOf(config: Record<string, unknown> = {}): unknown {
  const hook = vitestInlinePlugin().config
  return typeof hook === "function" ? Reflect.apply(hook, {}, [config, { command: "serve", mode: "test" }]) : undefined
}

describe("vitehub() in Vitest", () => {
  it("lets Vite transform the installed ViteHub packages, so their generated modules resolve", async () => {
    expect((await flatten(vitehub({ host: "node" }))).map(plugin => plugin.name)).toContain("vite-hub/vitest-inline")
    expect(configOf()).toEqual({ test: { server: { deps: { inline: [viteHubPackagePath] } } } })
  })

  it("matches ViteHub packages in npm and pnpm layouts, and no other package", () => {
    const paths = [
      "/app/node_modules/vite-hub/dist/env.js",
      "/app/node_modules/.pnpm/vite-hub@0.2.0/node_modules/vite-hub/dist/env.js",
      "/app/node_modules/.pnpm/@vite-hub+env@0.2.0/node_modules/@vite-hub/env/dist/runtime/server-env.js",
      "C:\\app\\node_modules\\@vite-hub\\database\\dist\\index.js",
    ]
    expect(paths.filter(path => viteHubPackagePath.test(path))).toEqual(paths)
    expect(["/app/node_modules/vite-hub-extra/index.js", "/app/node_modules/h3/dist/index.mjs", "/app/server/vite-hub/env.ts"].filter(path => viteHubPackagePath.test(path))).toEqual([])
  })

  it("keeps an inline: true of the app", () => {
    expect(configOf({ test: { server: { deps: { inline: true } } } })).toBeUndefined()
  })

  it("gives code generated for a Cloudflare host the cloudflare:workers stub of Node development", async () => {
    const plugin = vitestInlinePlugin()
    const call = (hook: Plugin["resolveId"] | Plugin["load"], id: string) => typeof hook === "function" ? Reflect.apply(hook, {}, [id, undefined, {}]) : undefined
    const id = call(plugin.resolveId, "cloudflare:workers")
    expect(call(plugin.load, id)).toBe(cloudflareWorkersDevShimSource)
    expect(call(plugin.resolveId, "cloudflare:email")).toBeUndefined()

    const { env } = await import(`data:text/javascript,${encodeURIComponent(cloudflareWorkersDevShimSource)}`)
    process.env.VITEHUB_TEST_SHIM = "read"
    expect(env.VITEHUB_TEST_SHIM).toBe("read")
    delete process.env.VITEHUB_TEST_SHIM
  })
})
