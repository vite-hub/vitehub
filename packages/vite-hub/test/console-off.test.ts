import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin, PluginOption } from "vite"
import { describe, expect, it } from "vitest"
import { vitehub, type ViteHubOptions } from "../src/index.ts"

/** The `/_vitehub` routes that `vite dev` serves for one `console` value. */
function consolePlugins(value: ViteHubOptions["console"]): Plugin[] {
  // SAFETY: vitehub() returns concrete plugins, and the included Nitro plugins as one nested list.
  const plugins = (vitehub({ comments: false, console: value, env: false, host: "node", schedule: true }) as PluginOption[]).flat() as Plugin[]
  return plugins.filter(plugin => plugin.name === "vite-hub/console")
}

async function devConsoleRoutes(value: ViteHubOptions["console"]): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-off-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n")
    const config: { nitro?: { handlers?: Array<{ route?: string }> }, root: string } = { root }
    for (const plugin of consolePlugins(value)) {
      const hook = plugin.config
      const handler = typeof hook === "function" ? hook : hook?.handler
      if (handler) await Reflect.apply(handler, {}, [config, { command: "serve", mode: "development" }])
    }
    return (config.nitro?.handlers ?? []).map(handler => handler.route ?? "").filter(route => route.startsWith("/_vitehub"))
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("console option in development", () => {
  it("serves only the operation RPC when console is unset", async () => {
    const routes = await devConsoleRoutes(undefined)
    expect(routes).toEqual(["/_vitehub/rpc", "/_vitehub"])
  })

  it("serves no /_vitehub route with console: false", async () => {
    await expect(devConsoleRoutes(false)).resolves.toEqual([])
  })

  it("serves the operation RPC when the Console is on", async () => {
    const routes = await devConsoleRoutes({ auth: false })
    // The page tools session is for the Console link of the page tools pill.
    expect(routes).toEqual(["/_vitehub/rpc", "/_vitehub", "/_vitehub/page/session"])
  })

  it.each([[undefined, 1], [false, 0], [true, 1]] as const)("installs the Console plugin with console: %o (%i)", (value, count) => {
    expect(consolePlugins(value)).toHaveLength(count)
  })
})
