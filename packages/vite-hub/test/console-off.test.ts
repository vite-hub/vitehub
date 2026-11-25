import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin, PluginOption } from "vite"
import { describe, expect, it } from "vitest"
import { vitehub, type ViteHubOptions } from "../src/index.ts"

/** The `/_vitehub` routes that `vite dev` serves for one `console` value. */
function consolePlugins(value: ViteHubOptions["console"], comments = false): Plugin[] {
  // SAFETY: vitehub() returns concrete plugins, and the included Nitro plugins as one nested list.
  const plugins = (vitehub({ comments, console: value, env: false, host: "node", schedule: true }) as PluginOption[]).flat() as Plugin[]
  return plugins.filter(plugin => plugin.name === "vite-hub/console")
}

async function devConsoleHandlers(value: ViteHubOptions["console"], comments = false): Promise<Array<{ handler?: string, route?: string }>> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-off-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n")
    const config: { nitro?: { handlers?: Array<{ handler?: string, route?: string }> }, root: string } = { root }
    for (const plugin of consolePlugins(value, comments)) {
      const hook = plugin.config
      const handler = typeof hook === "function" ? hook : hook?.handler
      if (handler) await Reflect.apply(handler, {}, [config, { command: "serve", mode: "development" }])
    }
    return (config.nitro?.handlers ?? []).filter(handler => handler.route?.startsWith("/_vitehub"))
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

async function devConsoleRoutes(value: ViteHubOptions["console"]): Promise<string[]> {
  return (await devConsoleHandlers(value)).map(handler => handler.route ?? "")
}

describe("console option in development", () => {
  it("serves only the operation RPC when console is unset", async () => {
    const routes = await devConsoleRoutes(undefined)
    expect(routes).toEqual(["/_vitehub/**", "/_vitehub", "/_vitehub/rpc"])
  })

  it("serves no /_vitehub route with console: false", async () => {
    await expect(devConsoleRoutes(false)).resolves.toEqual([])
  })

  it("serves the operation RPC when the Console is on", async () => {
    const routes = await devConsoleRoutes({ auth: false })
    expect(routes).toEqual(["/_vitehub/**", "/_vitehub", "/_vitehub/rpc"])
  })

  it("serves Site access on the same route only in an app with Comments", async () => {
    const [withoutComments] = await devConsoleHandlers({ auth: false })
    const [withComments] = await devConsoleHandlers({ auth: false }, true)
    expect(withoutComments?.handler).toMatch(/\/server\/entry\.js$/)
    expect(withComments).toMatchObject({ handler: expect.stringMatching(/\/server\/entry-site-access\.js$/), route: "/_vitehub/**" })
  })

  it.each([[undefined, 1], [false, 0], [true, 1]] as const)("installs the Console plugin with console: %o (%i)", (value, count) => {
    expect(consolePlugins(value)).toHaveLength(count)
  })
})
