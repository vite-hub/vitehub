import { relative, resolve } from "node:path"

import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { createProject } from "./support/content-cms.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

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
 * build, one line each, sorted. A Console route that a change adds or removes shows here.
 */
async function nitroInventory(consoleOptions: ConsoleOptions): Promise<{ handlers: string[], plugins: string[], publicAssets: string[] }> {
  const root = await createProject({
    "package.json": JSON.stringify({ name: "console-route-inventory", private: true, type: "module" }),
    "server/auth.ts": "import { defineAuth } from 'vite-hub/auth'\nexport default defineAuth({ emailAndPassword: { enabled: true } })\n",
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
      console: { ...consoleOptions, authorize: "./server/console-authorize.ts", invoke: true, mcpClient: true },
      database: true,
      kv: true,
      preset: "node",
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

/** Registered with every Console sign-in mode. */
const everyMode = {
  handlers: [
    "route ALL /_vitehub/mcp console/server/mcp.js",
    "route ALL /_vitehub/page/session app/.vitehub/nitro/comments/page-session.mjs",
    "route ALL /_vitehub/rpc/** console/server/rpc.js",
    "route ALL /api/_vitehub/comments/** app/.vitehub/nitro/comments/handler.mjs",
    "route ALL /api/auth/** app/.vitehub/auth/route.ts",
    "route GET /_vitehub/connections/callback app/.vitehub/nitro/connections/handler.ts",
    "route GET /_vitehub/connections/connect/** app/.vitehub/nitro/connections/handler.ts",
    "route POST /_vitehub/auth/manage console/server/auth-manage.js",
    "route POST /_vitehub/connections app/.vitehub/nitro/connections/handler.ts",
    "route POST /_vitehub/env/manage console/server/env-manage.js",
    "route POST /_vitehub/schedules/run console/server/schedule-run.js",
  ],
  plugins: [
    "app/.vitehub/nitro/agent/invocations.mjs",
    "app/.vitehub/nitro/blob/plugin.ts",
    "app/.vitehub/nitro/comments/plugin.mjs",
    "app/.vitehub/nitro/console/plugin.mjs",
    "app/.vitehub/nitro/error-log.mjs",
    "app/.vitehub/nitro/standard-context.mjs",
    "app/.vitehub/nitro/workflow/dev-plugin.mjs",
  ],
  publicAssets: [
    "/_vitehub/.well-known/skills console/public/skills",
    "/_vitehub/page/assets @vite-hub/comments/dist/page",
    "/api/_vitehub/comments/assets @vite-hub/comments/dist/overlay",
  ],
}

/** MCP OAuth discovery, with a Console sign-in that can issue OAuth tokens. */
const mcpOAuth = {
  handlers: [
    "middleware ALL (every request) console/server/mcp-discovery.js",
    "route GET /.well-known/oauth-authorization-server console/server/mcp-authorization-server.js",
    "route GET /.well-known/oauth-authorization-server/** console/server/mcp-authorization-server.js",
    "route GET /.well-known/oauth-protected-resource console/server/mcp-metadata.js",
    "route GET /.well-known/oauth-protected-resource/** console/server/mcp-metadata.js",
  ],
  plugins: ["console/server/mcp-discovery-nitro2.js"],
}

describe("Nitro routes of a production build with every Console section on", () => {
  it.each([
    {
      name: "app Auth",
      console: { auth: "app" },
      handlers: [...mcpOAuth.handlers, "middleware ALL /_vitehub/sign-in console/server/sign-in.js"],
      plugins: [...mcpOAuth.plugins, "console/server/console-preflight.js"],
    },
    {
      name: "a Console token",
      console: { auth: "token" },
      handlers: [],
      plugins: ["console/server/console-preflight.js"],
    },
    {
      name: "GitHub Console Auth",
      console: { auth: { provider: "github", allowedEmails: ["owner@example.com"], databasePath: ".data/console.sqlite" } },
      handlers: [
        ...mcpOAuth.handlers,
        "middleware ALL /** app/.vitehub/nitro/console/auth-middleware.mjs",
        "route ALL /_vitehub/api/auth/** app/.vitehub/nitro/console/auth-route.mjs",
        "route GET /_vitehub/sign-in app/.vitehub/nitro/console/auth-sign-in.mjs",
      ],
      plugins: mcpOAuth.plugins,
    },
  ] satisfies Array<{ name: string, console: ConsoleOptions, handlers: string[], plugins: string[] }>)("with $name as Console sign-in", async ({ console, handlers, plugins }) => {
    expect(await nitroInventory(console)).toEqual({
      handlers: [...everyMode.handlers, ...handlers].sort(),
      plugins: [...everyMode.plugins, ...plugins].sort(),
      publicAssets: everyMode.publicAssets,
    })
  }, 120_000)
})

describe("paths that the Console RPC route serves below /_vitehub/rpc/", () => {
  it("answers only the paths in this list, every other path is 404", async () => {
    const served: string[] = []
    for (const path of ["__call", "__upload", "__other"]) {
      const response = await handleConsoleRpcRequest(new Request(`http://app.test/_vitehub/rpc/${path}`, {
        body: "{}",
        headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
        method: "POST",
      }))
      if (response.status !== 404) served.push(path)
    }
    expect(served).toEqual(["__call"])
  })
})
