import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { build } from "esbuild"
import { consoleAuthMountBase, consoleAuthPath } from "./auth-path.ts"
import type { InlineConsoleAuth } from "./auth-inline.ts"

export interface ConsoleAuthFiles {
  server?: string
  client?: string
}

export type ConsoleAuthConfig = ConsoleAuthFiles | InlineConsoleAuth

export interface ResolvedConsoleAuthFiles {
  server: string
  client?: string
}

const sourceExtensions = [".ts", ".mts", ".js", ".mjs"]

function discoverFile(root: string, name: "server" | "client"): string | undefined {
  const candidates = sourceExtensions.map(extension => resolve(root, "vitehub/console/auth", `${name}${extension}`))
  const found = candidates.filter(existsSync)
  if (found.length > 1) throw new TypeError(`[vitehub] Multiple Console Auth ${name} files were found: ${found.join(", ")}`)
  return found[0]
}

export function resolveConsoleAuthFiles(root: string, config: ConsoleAuthFiles): ResolvedConsoleAuthFiles {
  const discoveredServer = discoverFile(root, "server")
  const discoveredClient = discoverFile(root, "client")
  if (config.server && discoveredServer) {
    throw new TypeError("[vitehub] Console Auth server is configured both by path and by vitehub/console/auth/server.")
  }
  if (config.client && discoveredClient) {
    throw new TypeError("[vitehub] Console Auth client is configured both by path and by vitehub/console/auth/client.")
  }
  const server = config.server ? resolve(root, config.server) : discoveredServer
  const client = config.client ? resolve(root, config.client) : discoveredClient
  if (!server || !existsSync(server)) {
    throw new TypeError("[vitehub] Console Auth needs vitehub/console/auth/server.ts or console.auth.server.")
  }
  if (client && !existsSync(client)) throw new TypeError(`[vitehub] Console Auth client file does not exist: ${client}`)
  const files: ResolvedConsoleAuthFiles = { server }
  if (client) files.client = client
  return files
}

export function resolveConsoleAuthConfig(root: string, config: ConsoleAuthConfig): ResolvedConsoleAuthFiles | InlineConsoleAuth {
  if ("provider" in config) {
    if (discoverFile(root, "server")) {
      throw new TypeError("[vitehub] Inline Console Auth conflicts with vitehub/console/auth/server.")
    }
    if (config.provider !== "github" || !config.allowedEmails?.length || !config.databasePath || config.databasePath === ":memory:") {
      throw new TypeError("[vitehub] Inline Console Auth requires provider: 'github', allowedEmails, and a persistent databasePath.")
    }
    if (config.client && discoverFile(root, "client")) {
      throw new TypeError("[vitehub] Console Auth client is configured both by path and by vitehub/console/auth/client.")
    }
    if (config.client && !existsSync(resolve(root, config.client))) {
      throw new TypeError(`[vitehub] Console Auth client file does not exist: ${config.client}`)
    }
    return config
  }
  return resolveConsoleAuthFiles(root, config)
}

export async function writeConsoleAuthHandlers(root: string, config: ResolvedConsoleAuthFiles | InlineConsoleAuth, mountBaseURL = "/"): Promise<{
  client: string
  middleware: string
  route: string
}> {
  const directory = resolve(root, ".vitehub/nitro/console")
  const definitionFile = resolve(directory, "auth-definition.mjs")
  const route = resolve(directory, "auth-route.mjs")
  const middleware = resolve(directory, "auth-middleware.mjs")
  const client = resolve(directory, "auth-client.mjs")
  const inline = "provider" in config
  const mountBase = consoleAuthMountBase(mountBaseURL)
  const clientFile = inline
    ? config.client ? resolve(root, config.client) : discoverFile(root, "client")
    : config.client
  const clientScript = clientFile
    ? (await build({
        absWorkingDir: root,
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        stdin: {
          contents: [
            `import config from ${JSON.stringify(clientFile)}`,
            'import { createAuthClient } from "vite-hub/auth/vue"',
            `const client = createAuthClient({ basePath: ${JSON.stringify(consoleAuthPath(mountBaseURL, "/api/_vitehub/console/auth"))}, plugins: config.plugins ?? [] })`,
            'globalThis[Symbol.for("vitehub.console.auth.client")] = client',
            'config.setup?.(client)',
          ].join("\n"),
          resolveDir: root,
          sourcefile: "vitehub-console-auth-client.ts",
        },
      })).outputFiles?.[0]?.text
    : ""
  if (clientFile && !clientScript) throw new TypeError("[vitehub] Could not build the Console Auth client extension.")
  await Promise.all([
    writeFileIfChanged(definitionFile, [
      ...(inline
        ? [
            'import { createInlineConsoleAuth } from "vite-hub/console/auth/inline"',
            `export const input = createInlineConsoleAuth(${JSON.stringify(config)})`,
          ]
        : [
            `import input from ${JSON.stringify(pathToFileURL(config.server).href)}`,
          ]),
      'import { createConsoleAuthDefinition, prepareConsoleAuth } from "vite-hub/console/auth"',
      `export const definition = createConsoleAuthDefinition(input, ${JSON.stringify(mountBaseURL)})`,
      "export function prepare(event) { return prepareConsoleAuth(input, definition, event.req, event) }",
      "",
    ].join("\n")),
    writeFileIfChanged(route, [
      'import { handleAuthRequest } from "#vitehub/auth/server"',
      'import { definition, prepare } from "./auth-definition.mjs"',
      "export default async function viteHubConsoleAuthRoute(event) {",
      "  await prepare(event)",
      "  return handleAuthRequest(definition, event.req, undefined, event)",
      "}",
      "",
    ].join("\n")),
    writeFileIfChanged(middleware, [
      'import { requireAuthAccessRoutes } from "#vitehub/auth/server"',
      'import { definition, prepare } from "./auth-definition.mjs"',
      "export default async function viteHubConsoleAuthMiddleware(event) {",
      `  const mountBase = ${JSON.stringify(mountBase)}`,
      "  const publicPath = event.url.pathname",
      "  const path = mountBase && publicPath.startsWith(`${mountBase}/`) ? publicPath.slice(mountBase.length) : publicPath",
      "  if (path === '/api/_vitehub/console/auth' || path.startsWith('/api/_vitehub/console/auth/')) return",
      "  if (!(path === '/_vitehub' || path.startsWith('/_vitehub/') || path === '/api/_vitehub/console' || path.startsWith('/api/_vitehub/console/'))) return",
      "  await prepare(event)",
      "  if (path === '/_vitehub' || path.startsWith('/_vitehub/')) return requireAuthAccessRoutes(event, [0], definition, [0])",
      "  if (path === '/api/_vitehub/console' || path.startsWith('/api/_vitehub/console/')) return requireAuthAccessRoutes(event, [1], definition, [1])",
      "}",
      "",
    ].join("\n")),
    writeFileIfChanged(client, [
      `const script = ${JSON.stringify(clientScript)}`,
      "export default function viteHubConsoleAuthClient() {",
      '  return new Response(script, { headers: { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff" } })',
      "}",
      "",
    ].join("\n")),
  ])
  return { client, middleware, route }
}
