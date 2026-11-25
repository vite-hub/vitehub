import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

const consoleRoutes = ["/_vitehub", "/_vitehub/**", "/_vitehub/rpc"]

it.each([
  ["no primitives", { env: false }],
  ["only Server Env", { env: true }],
  ["only KV", { env: false, kv: true }],
  ["Agents", { agent: true, env: false }],
  ["only Schedules", { schedule: true, env: false }],
] as const)("keeps the same lazy Console routes with %s", async (_name, features) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-section-routes-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n")
    const plugin = consoleVitePlugin({ console: {}, sections: resolveConsoleSectionIds(features) })
    const hook = plugin.config
    const config: { nitro?: { handlers?: Array<{ lazy?: boolean, route?: string }> }, root: string } = { root }
    await Reflect.apply(typeof hook === "function" ? hook : hook!.handler, {}, [config, { command: "build", mode: "production" }])

    const handlers = config.nitro?.handlers?.filter(handler => handler.route?.startsWith("/_vitehub")) ?? []
    expect(handlers.map(handler => handler.route).sort()).toEqual(consoleRoutes)
    expect(handlers.every(handler => handler.lazy)).toBe(true)
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
