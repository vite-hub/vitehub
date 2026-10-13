import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { env } from "@vite-hub/env"
import { createRuntimeEnvRegistry } from "@vite-hub/env/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { build } from "esbuild"
import { resolveInlineConsoleAuthGates, type InlineConsoleAuth } from "./auth-inline-config.ts"
import { cloudflareAccessIssuer, consoleAuthMountBase, consoleAuthPath } from "./auth-path.ts"

import type { EnvRuntimeRegistry } from "@vite-hub/env"
import type { CloudflareAccessConsoleAuth } from "./auth-cloudflare-access.ts"
import type { ConsoleAuthMode } from "./internal.ts"

export interface ConsoleAuthFiles {
  server?: string
  client?: string
}

export type ConsoleAuthConfig = ConsoleAuthFiles | InlineConsoleAuth | CloudflareAccessConsoleAuth

export interface ResolvedCloudflareAccessConsoleAuth {
  provider: "cloudflare-access"
  settings: EnvRuntimeRegistry
}

export type ResolvedConsoleAuthConfig = ResolvedConsoleAuthFiles | InlineConsoleAuth | ResolvedCloudflareAccessConsoleAuth

export interface SessionConsoleAuthHandlers {
  auth: true
  client: string
  clientSource?: string
  clientSources: string[]
  middleware: string
  route: string
  signIn: string
}

export interface CloudflareAccessConsoleAuthHandlers {
  auth: "cloudflare-access"
  client?: undefined
  clientSource?: undefined
  clientSources: string[]
  middleware: string
  route?: undefined
  signIn?: undefined
}

export type ConsoleAuthHandlers = SessionConsoleAuthHandlers | CloudflareAccessConsoleAuthHandlers

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

/** Return the Console Auth mode that the generated handlers serve. Cloudflare Access has no edge in development. */
export function registeredConsoleAuthMode(config: ConsoleAuthConfig | undefined, development: boolean): ConsoleAuthMode | false {
  if (!config) return false
  if ("provider" in config && config.provider === "cloudflare-access") return development ? false : "cloudflare-access"
  return true
}

function resolveCloudflareAccessConsoleAuth(root: string, config: CloudflareAccessConsoleAuth): ResolvedCloudflareAccessConsoleAuth {
  if (discoverFile(root, "server")) {
    throw new TypeError("[vitehub] Cloudflare Access Console Auth conflicts with vitehub/console/auth/server.")
  }
  if (discoverFile(root, "client")) {
    throw new TypeError("[vitehub] Cloudflare Access Console Auth does not use vitehub/console/auth/client.")
  }
  const values = {
    audience: config.audience ?? env({ source: env.source("CF_ACCESS_AUD") }),
    teamDomain: config.teamDomain ?? env({ source: env.source("CF_ACCESS_TEAM_DOMAIN") }),
  }
  for (const [key, value] of Object.entries(values)) {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A setting is either a literal string or an Env declaration.
    if (typeof value === "string") {
      if (key === "teamDomain" ? !cloudflareAccessIssuer(value) : !value.trim()) {
        throw new TypeError(`[vitehub] Cloudflare Access Console Auth ${key} must be ${key === "teamDomain" ? "an HTTPS team domain such as acme.cloudflareaccess.com" : "a non-empty Application Audience (AUD) tag"}.`)
      }
    }
    else if (value.source?.kind === "provider") {
      throw new TypeError(`[vitehub] Cloudflare Access Console Auth ${key} cannot use env.provider() because the Console guard resolves it for each request without loading providers.`)
    }
  }
  const settings = createRuntimeEnvRegistry(values, { path: "console.auth" })
  return { provider: "cloudflare-access", settings }
}

export function resolveConsoleAuthConfig(root: string, config: ConsoleAuthConfig, preset = "node"): ResolvedConsoleAuthConfig {
  if ("provider" in config && config.provider === "cloudflare-access") return resolveCloudflareAccessConsoleAuth(root, config)
  if ("provider" in config) {
    if (preset !== "node") {
      throw new TypeError("[vitehub] Inline Console Auth uses node:sqlite and requires the Node deployment preset. Use a file-based Console Auth Definition for other presets.")
    }
    if (discoverFile(root, "server")) {
      throw new TypeError("[vitehub] Inline Console Auth conflicts with vitehub/console/auth/server.")
    }
    resolveInlineConsoleAuthGates(config)
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

/** The generated Console Auth middleware. It also exports `checkConsoleAccess` for the Console data routes. */
export function consoleAuthMiddlewareFile(root: string): string {
  return resolve(root, ".vitehub/nitro/console/auth-middleware.mjs")
}

async function writeCloudflareAccessMiddleware(root: string, config: ResolvedCloudflareAccessConsoleAuth, mountBaseURL: string): Promise<CloudflareAccessConsoleAuthHandlers> {
  const middleware = consoleAuthMiddlewareFile(root)
  await writeFileIfChanged(middleware, [
    'import { resolveServerEnv } from "vite-hub/env/server"',
    'import { handleCloudflareAccessConsoleRequest, verifyCloudflareAccessConsoleRequest } from "vite-hub/console/auth/cloudflare-access"',
    `const settings = JSON.parse(${JSON.stringify(JSON.stringify(config.settings))})`,
    "export default function viteHubConsoleAuthMiddleware(event) {",
    `  return handleCloudflareAccessConsoleRequest(event, () => resolveServerEnv(settings, event), ${JSON.stringify(mountBaseURL)})`,
    "}",
    "// Each Console data route calls this check, whatever its path.",
    "export function checkConsoleAccess(event) {",
    "  return verifyCloudflareAccessConsoleRequest(event.req, () => resolveServerEnv(settings, event))",
    "}",
    "",
  ].join("\n"))
  return { auth: "cloudflare-access", clientSources: [], middleware }
}

export async function writeConsoleAuthHandlers(root: string, config: ResolvedCloudflareAccessConsoleAuth, mountBaseURL?: string): Promise<CloudflareAccessConsoleAuthHandlers>
export async function writeConsoleAuthHandlers(root: string, config: ResolvedConsoleAuthFiles | InlineConsoleAuth, mountBaseURL?: string): Promise<SessionConsoleAuthHandlers>
export async function writeConsoleAuthHandlers(root: string, config: ResolvedConsoleAuthConfig, mountBaseURL?: string): Promise<ConsoleAuthHandlers>
export async function writeConsoleAuthHandlers(root: string, config: ResolvedConsoleAuthConfig, mountBaseURL = "/"): Promise<ConsoleAuthHandlers> {
  const directory = resolve(root, ".vitehub/nitro/console")
  if ("settings" in config) return writeCloudflareAccessMiddleware(root, config, mountBaseURL)
  const definitionFile = resolve(directory, "auth-definition.mjs")
  const route = resolve(directory, "auth-route.mjs")
  const signIn = resolve(directory, "auth-sign-in.mjs")
  const middleware = consoleAuthMiddlewareFile(root)
  const client = resolve(directory, "auth-client.mjs")
  const inline = "provider" in config
  const mountBase = consoleAuthMountBase(mountBaseURL)
  const clientFile = inline
    ? config.client ? resolve(root, config.client) : discoverFile(root, "client")
    : config.client
  const clientBuild = clientFile
    ? await build({
        absWorkingDir: root,
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        metafile: true,
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
      })
    : undefined
  const clientScript = clientBuild?.outputFiles?.[0]?.text ?? ""
  const clientSources = clientFile
    ? [...new Set([clientFile, ...Object.keys(clientBuild?.metafile?.inputs ?? {})
        .filter(input => !input.includes("node_modules/") && input !== "vitehub-console-auth-client.ts")
        .map(input => resolve(root, input))])]
    : []
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
            "export { input }",
          ]),
      'import { createConsoleAuthDefinition, prepareConsoleAuth } from "vite-hub/console/auth"',
      `export const definition = createConsoleAuthDefinition(input, ${JSON.stringify(mountBaseURL)})`,
      "export const signInProvider = input.signIn.provider",
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
    writeFileIfChanged(signIn, [
      'import { consoleAuthSignInPage } from "vite-hub/console/auth"',
      'import { signInProvider } from "./auth-definition.mjs"',
      `export default function viteHubConsoleSignIn(event) { return consoleAuthSignInPage(signInProvider, event.req, ${JSON.stringify(mountBaseURL)}) }`,
      "",
    ].join("\n")),
    writeFileIfChanged(middleware, [
      'import { requireAuthAccessRoutes, withAuthorization } from "#vitehub/auth/server"',
      'import { consoleAuthPageResponse } from "vite-hub/console/auth"',
      'import { definition, input, prepare } from "./auth-definition.mjs"',
      "const authorizeConsoleAccess = withAuthorization(input.authorize, () => undefined, definition)",
      "// Each Console data route calls this check, whatever its path. It never redirects to sign-in.",
      "export async function checkConsoleAccess(event) {",
      "  await prepare(event)",
      "  return authorizeConsoleAccess(event)",
      "}",
      "export default async function viteHubConsoleAuthMiddleware(event) {",
      `  const mountBase = ${JSON.stringify(mountBase)}`,
      "  const publicPath = event.url.pathname",
      "  const path = mountBase && publicPath.startsWith(`${mountBase}/`) ? publicPath.slice(mountBase.length) : publicPath",
      "  if (path === '/api/_vitehub/console/auth' || path.startsWith('/api/_vitehub/console/auth/')) return",
      "  if (path === '/_vitehub/sign-in') return",
      "  if (!(path === '/_vitehub' || path.startsWith('/_vitehub/') || path === '/api/_vitehub/console' || path.startsWith('/api/_vitehub/console/'))) return",
      "  await prepare(event)",
      "  if (path === '/_vitehub' || path.startsWith('/_vitehub/')) return consoleAuthPageResponse(event.req, await requireAuthAccessRoutes(event, [0], definition, [0], { redirectToSignIn: path === '/_vitehub' && event.url.searchParams.has('auth_start') }), mountBase)",
      "  if (path === '/api/_vitehub/console' || path.startsWith('/api/_vitehub/console/')) return requireAuthAccessRoutes(event, [1], definition, [1], { redirectToSignIn: false })",
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
  return { auth: true, client, clientSource: clientFile, clientSources, middleware, route, signIn }
}

/** Module id that the generated Connections management handler imports to identify the actor. */
export const consoleConnectionsActorId = "#vitehub/console/connections-actor"

/**
 * Where the Connections manager id comes from. The installed Console access policy checks every request first.
 * `console-auth` reads the Console Auth session, `app-auth` reads the app Auth session, and `none` uses
 * `user:<mode>` for `console: true`, `host-managed`, and Cloudflare Access.
 */
export type ConsoleConnectionsActorSource = "app-auth" | "console-auth" | "none"

/** Write the Connections access policy module. It checks each management request with the Console access policy. */
export async function writeConsoleConnectionsActor(root: string, source: ConsoleConnectionsActorSource): Promise<string> {
  const file = resolve(root, ".vitehub/nitro/console/connections-actor.mjs")
  const session = {
    "app-auth": [
      'import { getAuthForRequest } from "#vitehub/auth/server"',
      'import { consoleSessionActor } from "vite-hub/console/auth"',
      'import { consoleConnectionsActor } from "vite-hub/console/sections"',
      "export default function viteHubConsoleConnectionsActor(request, event) {",
      "  return consoleConnectionsActor(event, () => consoleSessionActor(getAuthForRequest(request, undefined, event), request))",
      "}",
    ],
    "console-auth": [
      'import { createAuthForRequest } from "#vitehub/auth/server"',
      'import { consoleSessionActor } from "vite-hub/console/auth"',
      'import { consoleConnectionsActor } from "vite-hub/console/sections"',
      'import { definition } from "./auth-definition.mjs"',
      "export default function viteHubConsoleConnectionsActor(request, event) {",
      "  return consoleConnectionsActor(event, () => consoleSessionActor(createAuthForRequest(definition, request, undefined, event), request))",
      "}",
    ],
    "none": [
      'import { consoleConnectionsActor } from "vite-hub/console/sections"',
      "export default function viteHubConsoleConnectionsActor(request, event) {",
      "  return consoleConnectionsActor(event)",
      "}",
    ],
  }[source]
  await writeFileIfChanged(file, [...session, ""].join("\n"))
  return file
}
