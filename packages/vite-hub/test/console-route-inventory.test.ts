import { relative, resolve } from "node:path"

import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { createProject } from "./support/content-cms.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

import { operationRpcBody } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleOptions } from "../src/index.ts"

const packageRoot = resolve(import.meta.dirname, "..")
const packagesRoot = resolve(packageRoot, "..")
const consoleRuntime = resolve(packageRoot, "src/console/runtime")

type NitroEntry = { baseURL?: string, dir?: string, handler?: string, method?: string | string[], middleware?: boolean, route?: string }

/** A path that reads the same on every machine: `console/`, `app/`, or `@vite-hub/<package>/`. */
function owner(root: string, path: string): string {
  if (path.startsWith(`${consoleRuntime}/`)) return `console/${relative(consoleRuntime, path)}`
  if (path.startsWith(`${root}/`)) return `app/${relative(root, path)}`
  if (path.startsWith(`${packagesRoot}/`)) return `@vite-hub/${relative(packagesRoot, path)}`
  return path
}

/**
 * Every route, middleware, Nitro plugin, and public asset directory that ViteHub hands to Nitro for one production
 * build, one line each, sorted. A Console route that a change adds or removes shows here. `connections.management` sets
 * the app's own actor module, so the Connections management API is the app's, not the Console's.
 */
async function nitroInventory(consoleOptions: true | ConsoleOptions): Promise<{ handlers: string[], plugins: string[], publicAssets: string[] }> {
  const root = await createProject({
    "package.json": JSON.stringify({ name: "console-route-inventory", private: true, type: "module" }),
    "server/auth.ts": "import { defineAuth } from 'vite-hub/auth'\nexport default defineAuth({ database: 'memory', emailAndPassword: { enabled: true } })\n",
    "server/comments.ts": "import { defineComments } from 'vite-hub/comments'\nexport default defineComments({ authorize: () => true })\n",
    "server/connections-actor.ts": "export default () => ({ id: 'owner' })\n",
    "server/console-authorize.ts": "export default () => true\n",
    "server/schedules/daily.ts": "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '0 0 * * *', run: () => {} })\n",
  })
  const resolved = await resolveConfig({
    configFile: false,
    logLevel: "silent",
    plugins: vitehub({
      agent: true,
      auth: true,
      blob: true,
      channels: true,
      comments: true,
      connections: { management: { actor: "./server/connections-actor.ts" } },
      console: consoleOptions,
      database: true,
      kv: true,
      host: "node",
      schedule: { providerOutput: false },
      workflow: true,
    }),
    root,
  }, "build", "production")
  const nitro: { handlers?: NitroEntry[], plugins?: string[], publicAssets?: NitroEntry[] } = Object(Reflect.get(resolved, "nitro"))
  return {
    handlers: (nitro.handlers ?? []).map(entry => [
      entry.middleware ? "middleware" : "route",
      entry.method ? [entry.method].flat().join(",").toUpperCase() : "ALL",
      entry.route ?? "(every request)",
      owner(root, entry.handler ?? ""),
    ].join(" ")).sort(),
    plugins: (nitro.plugins ?? []).map(plugin => owner(root, plugin)).sort(),
    publicAssets: (nitro.publicAssets ?? []).map(asset => `${asset.baseURL} ${owner(root, asset.dir ?? "")}`).sort(),
  }
}

/**
 * The one Console route of an app, `/_vitehub/rpc`. The ViteHub Console and the CLI `POST` signed calls to it, and a
 * browser `GET`s it with a one-time ticket, for Content preview and impersonation.
 */
const consoleRoutes = [
  "route ALL /_vitehub/rpc console/server/rpc.js",
]

/**
 * App features that stay on purpose. They serve the app and its visitors, with the app's own identity, not the Console:
 * Blob signed links, the Comments overlay, app Auth, and the Connections management API with the app's own actor module.
 */
const appRoutes = [
  // Signed links for private files in the app's fs Blob store.
  "route ALL /_vitehub/blob/signed/** @vite-hub/blob/dist/runtime/signed.js",
  // The Comments API of the overlay, with the app's own identity.
  "route ALL /api/_vitehub/comments/** app/.vitehub/nitro/comments/handler.mjs",
  // The page tools session of the Comments overlay: which tools this visitor may load on a page of the app.
  "route ALL /_vitehub/page/session app/.vitehub/nitro/comments/page-session.mjs",
  // App Auth: the sign-in of the app's own users.
  "route ALL /api/auth/** app/.vitehub/auth/route.ts",
  // The Connections management API of the app. The test config mounts it with the app's own actor module.
  "route GET /_vitehub/connections/callback app/.vitehub/nitro/connections/handler.ts",
  "route GET /_vitehub/connections/connect/** app/.vitehub/nitro/connections/handler.ts",
  "route POST /_vitehub/connections app/.vitehub/nitro/connections/handler.ts",
]

const plugins = [
  "@vite-hub/kv/dist/runtime/nitro-plugin.js",
  "app/.vitehub/nitro/agent/invocations.mjs",
  "app/.vitehub/nitro/blob/plugin.ts",
  "app/.vitehub/nitro/comments/plugin.mjs",
  "app/.vitehub/nitro/console/plugin.mjs",
  "app/.vitehub/nitro/durability/plugin.mjs",
  "app/.vitehub/nitro/error-log.mjs",
  "app/.vitehub/nitro/standard-context.mjs",
  "app/.vitehub/nitro/workflow/dev-plugin.mjs",
]

const publicAssets = [
  // The public ViteHub skill of the installed `vite-hub` version, for `npx skills add <app>/_vitehub`. Static files.
  "/_vitehub/.well-known/skills console/public/skills",
  // The Console link of the page tools pill. Comments added the session route and the loader first, so they stay.
  "/_vitehub/console/assets console/page-tool",
  // The page tools loader and the Comments overlay script.
  "/_vitehub/page/assets @vite-hub/comments/dist/page",
  "/api/_vitehub/comments/assets @vite-hub/comments/dist/overlay",
]

describe("Nitro routes of a production build with every Console section on", () => {
  it("serves one Console route, /_vitehub/rpc, and the app features that stay", async () => {
    const inventory = await nitroInventory({ invoke: true, mcpClient: true })
    expect(inventory).toEqual({ handlers: [...consoleRoutes, ...appRoutes].sort(), plugins, publicAssets })
    // The Console MCP, OAuth discovery, CORS, sign-in, Console Auth, and Env management are gone from apps.
    const removed = ["/.well-known/oauth", "/_vitehub/mcp", "/_vitehub/sign-in", "/_vitehub/api/auth", "/_vitehub/env/manage", "/_vitehub/auth/manage"]
    expect(inventory.handlers.filter(line => removed.some(path => line.split(" ")[2]!.startsWith(path)))).toEqual([])
    expect(inventory.handlers.filter(line => line.startsWith("middleware"))).toEqual([])
    expect(inventory.plugins.filter(plugin => /console-preflight|mcp-discovery/.test(plugin))).toEqual([])
  }, 120_000)

  it.each([
    { name: "console: true", options: true },
    { name: "console.authorize", options: { authorize: "./server/console-authorize.ts", impersonation: true } },
  ] satisfies Array<{ name: string, options: true | ConsoleOptions }>)("serves the same Console routes with $name", async ({ options }) => {
    const inventory = await nitroInventory(options)
    expect(inventory.handlers.filter(line => line.includes(" console/"))).toEqual(consoleRoutes)
  }, 120_000)
})

describe("paths that the Console RPC route serves", () => {
  it("answers only POST /_vitehub/rpc, every other path is 404", async () => {
    const served: string[] = []
    for (const path of ["/_vitehub/rpc", "/_vitehub/rpc/", "/_vitehub/rpc/__call", "/_vitehub/rpc/__upload", "/_vitehub/rpc/__other"]) {
      const response = await handleConsoleRpcRequest(new Request(`http://app.test${path}`, {
        body: operationRpcBody("sections.list"),
        headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
        method: "POST",
      }))
      if (response.status !== 404) served.push(path)
    }
    expect(served).toEqual(["/_vitehub/rpc"])
  })
})
