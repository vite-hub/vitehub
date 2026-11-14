import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
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
    expect((await flatten(vitehub({ host: "node" }))).map(plugin => plugin.name)).toContain("vite-hub:vitest-inline")
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
})
