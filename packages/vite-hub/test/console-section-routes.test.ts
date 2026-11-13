import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

// Every app with Console access serves the operation RPC and the page tools session of the Console link, and no other
// Console route.
const consoleRoutes = ["/_vitehub/rpc", "/_vitehub/page/session"]

it.each([
  ["no primitives", { env: false }, []],
  ["only Server Env", { env: true }, []],
  ["only KV", { env: false, kv: true }, []],
  ["Agents", { agent: true, env: false }, []],
  ["only Schedules", { schedule: true, env: false }, []],
] as const)("builds only the Console routes of enabled sections: %s", async (_name, features, sectionRoutes) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-section-routes-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n")
    const plugin = consoleVitePlugin({ console: {}, sections: resolveConsoleSectionIds(features) })
    const hook = plugin.config
    const config: { nitro?: { handlers?: Array<{ route?: string }> }, root: string } = { root }
    await Reflect.apply(typeof hook === "function" ? hook : hook!.handler, {}, [config, { command: "build", mode: "production" }])

    const routes = config.nitro?.handlers?.flatMap(handler => handler.route?.startsWith("/_vitehub") ? [handler.route] : []) ?? []
    expect(routes.sort()).toEqual([...consoleRoutes, ...sectionRoutes].sort())
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
