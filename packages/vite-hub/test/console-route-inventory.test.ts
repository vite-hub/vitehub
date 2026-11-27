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

describe("generated Agent routes with the Console fallback", () => {
  it.each(["serve", "build"] as const)("registers standalone Channels and readiness during %s", async (command) => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "agent-console-routes", private: true, type: "module" }),
      "server/channels/intake.ts": "import { defineChannel } from 'vite-hub/channels'\nimport { webhook } from 'vite-hub/channels/adapters'\nexport default defineChannel({ adapter: webhook({ secret: false }) })\n",
      "server/agents/support.ts": "import { defineAgent } from 'vite-hub/agent'\nexport default defineAgent({ driver: { run: () => 'ok' } })\n",
    })
    const resolved = await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: vitehub({
        agent: { preparation: { workspace: "docs" } },
        channels: true,
        host: "node",
        ...(command === "build" ? { console: true } : {}),
      }),
      root,
    }, command, command === "build" ? "production" : "development")
    const nitro: { handlers?: NitroEntry[] } = Object(Reflect.get(resolved, "nitro"))
    expect(nitro.handlers?.map(handler => handler.route)).toEqual(expect.arrayContaining([
      "/_vitehub/**", "/_vitehub/channels/intake", "/_vitehub/ready",
    ]))
  })
})

function owner(root: string, path: string): string {
  if (path.startsWith(`${consoleRuntime}/`)) return `console/${relative(consoleRuntime, path)}`
  if (path.startsWith(`${root}/`)) return `app/${relative(root, path)}`
  if (path.startsWith(`${packagesRoot}/`)) return `@vite-hub/${relative(packagesRoot, path)}`
  return path
}

async function nitroInventory(consoleOptions: true | ConsoleOptions): Promise<{ handlers: string[], plugins: string[], publicAssets: string[] }> {
  const root = await createProject({
    "package.json": JSON.stringify({ name: "console-route-inventory", private: true, type: "module" }),
    "server/auth.ts": "import { defineAuth } from 'vite-hub/auth'\nexport default defineAuth({ database: 'memory', emailAndPassword: { enabled: true } })\n",
    "server/comments.ts": "import { defineComments } from 'vite-hub/comments'\nexport default defineComments({ authorize: () => true })\n",
    "server/connections-actor.ts": "export default () => ({ id: 'owner' })\n",
    "server/console-authorize.ts": "export default () => true\n",
    "server/schedules/daily.ts": "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '0 0 * * *', handler: () => {} })\n",
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
      workflow: { driver: "vercel" },
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

const consoleRoutes = [
  "route ALL /_vitehub console/server/entry-site-access.js",
  "route ALL /_vitehub/** console/server/entry-site-access.js",
  "route ALL /_vitehub/rpc console/server/entry-site-access.js",
  "route ALL /_vitehub/site console/server/entry-site-access.js",
]

const appRoutes = [
  "route ALL /_vitehub/blob-signed/** @vite-hub/blob/dist/runtime/signed.js",
  "route ALL /_vitehub/comments/** app/.vitehub/nitro/comments/handler.mjs",
  "route ALL /_vitehub/page/tools app/.vitehub/nitro/comments/page-tools-route.mjs",
  "route ALL /api/auth/** app/.vitehub/auth/route.ts",
  "route GET /_vitehub/connections/callback app/.vitehub/nitro/connections/handler.ts",
  "route GET /_vitehub/connections/connect/** app/.vitehub/nitro/connections/handler.ts",
  "route POST /_vitehub/connections app/.vitehub/nitro/connections/handler.ts",
]

const plugins = [
  "@vite-hub/auth/dist/runtime/client-request-plugin.js",
  "@vite-hub/kv/dist/runtime/nitro-plugin.js",
  "app/.vitehub/nitro/agent/invocations.mjs",
  "app/.vitehub/nitro/blob/plugin.ts",
  "app/.vitehub/nitro/comments/plugin.mjs",
  "app/.vitehub/nitro/durability/plugin.mjs",
  "app/.vitehub/nitro/error-log.mjs",
  "app/.vitehub/nitro/request-policy.mjs",
  "app/.vitehub/nitro/schedule/plugin.ts",
  "app/.vitehub/nitro/standard-context.mjs",
  "app/.vitehub/nitro/workflow/build-plugin.mjs",
  "console/operation-loader.js",
]

const publicAssets = [
  "/_vitehub/comments/assets @vite-hub/comments/dist/overlay",
  "/_vitehub/page/assets @vite-hub/comments/dist/page",
]

describe("Nitro routes of a production build with every Console section on", () => {
  it("serves the Console routes, /_vitehub/rpc and /_vitehub, and the app features that stay", async () => {
    const inventory = await nitroInventory({ invoke: true })
    expect(inventory).toEqual({ handlers: [...consoleRoutes, ...appRoutes].sort(), plugins, publicAssets })
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
