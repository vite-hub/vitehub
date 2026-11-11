import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

// Every app with Console access serves the operation RPC and the MCP endpoint.
const consoleRoutes = ["/_vitehub/rpc/**", "/_vitehub/mcp"]

it.each([
  ["no primitives", { env: false }, []],
  ["only Server Env", { env: true }, ["/_vitehub/env/manage"]],
  ["only KV", { env: false, kv: true }, []],
  ["Agents", { agent: true, env: false }, ["/_vitehub/channels/replay"]],
  ["only Schedules", { schedule: true, env: false }, ["/_vitehub/schedules/run"]],
] as const)("builds only the Console routes of enabled sections: %s", async (_name, features, sectionRoutes) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-section-routes-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n")
    const plugin = consoleVitePlugin({ console: { auth: "token" }, preset: "node", sections: resolveConsoleSectionIds(features) })
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
