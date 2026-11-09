import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

// The routes that every Console has: its page, its client, the operation RPC, the MCP endpoint, and the page tools.
const consoleRoutes = ["/_vitehub", "/_vitehub/**", "/_vitehub/api/client.js", "/_vitehub/rpc/**", "/_vitehub/mcp", "/_vitehub/page/session"]

it.each([
  ["no primitives", { env: false }, []],
  ["only Server Env", { env: true }, ["/_vitehub/env/manage"]],
  ["only KV", { env: false, kv: true }, []],
  ["Agents", { agent: true, env: false }, ["/_vitehub/api/status", "/_vitehub/api/usage", "/_vitehub/channels/replay"]],
] as const)("builds only the Console routes of enabled sections: %s", async (_name, features, sectionRoutes) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-section-routes-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n")
    const plugin = consoleVitePlugin({ console: { auth: false }, preset: "node", sections: resolveConsoleSectionIds(features) })
    const hook = plugin.config
    const config: { nitro?: { handlers?: Array<{ route?: string }> }, root: string } = { root }
    await Reflect.apply(typeof hook === "function" ? hook : hook!.handler, {}, [config, { command: "build", mode: "production" }])

    const routes = config.nitro?.handlers?.flatMap(handler => handler.route?.startsWith("/_vitehub") ? [handler.route] : []) ?? []
    // The Schedule run route follows the Schedules section in its own change, so this list leaves it out.
    expect(routes.filter(route => route !== "/_vitehub/schedules/run").sort()).toEqual([...consoleRoutes, ...sectionRoutes].sort())
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
