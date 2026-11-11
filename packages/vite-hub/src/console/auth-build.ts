import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { env } from "@vite-hub/env"
import { createRuntimeEnvRegistry } from "@vite-hub/env/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { resolveInlineConsoleAuthGates, type InlineConsoleAuth } from "./auth-inline-config.ts"
import { cloudflareAccessIssuer, consoleAuthMountBase } from "./auth-path.ts"
import { generatedModules } from "../internal/generated-modules.ts"

import type { EnvRuntimeRegistry } from "@vite-hub/env"
import type { CloudflareAccessConsoleAuth } from "./auth-cloudflare-access.ts"
import type { ConsoleAuthMode } from "./internal.ts"

export interface ConsoleAuthFiles {
  server?: string
}

export type ConsoleAuthConfig = ConsoleAuthFiles | InlineConsoleAuth | CloudflareAccessConsoleAuth

export interface ResolvedCloudflareAccessConsoleAuth {
  provider: "cloudflare-access"
  settings: EnvRuntimeRegistry
}

export type ResolvedConsoleAuthConfig = ResolvedConsoleAuthFiles | InlineConsoleAuth | ResolvedCloudflareAccessConsoleAuth

export interface SessionConsoleAuthHandlers {
  auth: true
  middleware: string
  route: string
  signIn: string
}

export interface CloudflareAccessConsoleAuthHandlers {
  auth: "cloudflare-access"
  middleware: string
  route?: undefined
  signIn?: undefined
}

export type ConsoleAuthHandlers = SessionConsoleAuthHandlers | CloudflareAccessConsoleAuthHandlers

export interface ResolvedConsoleAuthFiles {
  server: string
}

const sourceExtensions = [".ts", ".mts", ".js", ".mjs"]

function discoverFile(root: string, name: "server" | "client"): string | undefined {
  const candidates = sourceExtensions.map(extension => resolve(root, "vitehub/console/auth", `${name}${extension}`))
  const found = candidates.filter(existsSync)
  if (found.length > 1) throw new TypeError(`[vitehub] Multiple Console Auth ${name} files were found: ${found.join(", ")}`)
  return found[0]
}

/** The Console Auth browser client extended the Console page, which apps no longer serve. */
function rejectConsoleAuthClient(root: string, client: unknown): void {
  if (client === undefined && !discoverFile(root, "client")) return
  throw new TypeError("[vitehub] The Console Auth client (console.auth.client, vitehub/console/auth/client) was removed with the Console page that apps served. Delete it.")
}

export function resolveConsoleAuthFiles(root: string, config: ConsoleAuthFiles): ResolvedConsoleAuthFiles {
  rejectConsoleAuthClient(root, Reflect.get(config, "client"))
  const discoveredServer = discoverFile(root, "server")
  if (config.server && discoveredServer) {
    throw new TypeError("[vitehub] Console Auth server is configured both by path and by vitehub/console/auth/server.")
  }
  const server = config.server ? resolve(root, config.server) : discoveredServer
  if (!server || !existsSync(server)) {
    throw new TypeError("[vitehub] Console Auth needs vitehub/console/auth/server.ts or console.auth.server.")
  }
  return { server }
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
    rejectConsoleAuthClient(root, Reflect.get(config, "client"))
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
    'import { resolveServerEnv } from "vite-hub/env"',
    `import { handleCloudflareAccessConsoleRequest, verifyCloudflareAccessConsoleRequest } from ${JSON.stringify(generatedModules.consoleAuthCloudflareAccess)}`,
    `const settings = JSON.parse(${JSON.stringify(JSON.stringify(config.settings))})`,
    "export default function viteHubConsoleAuthMiddleware(event) {",
    `  return handleCloudflareAccessConsoleRequest(event, () => resolveServerEnv(settings, event), ${JSON.stringify(mountBaseURL)})`,
    "}",
    "// Each Console data route calls this check, whatever its path.",
    "export function checkConsoleAccess(event) {",
    "  return verifyCloudflareAccessConsoleRequest(event, () => resolveServerEnv(settings, event))",
    "}",
    "",
  ].join("\n"))
  return { auth: "cloudflare-access", middleware }
}

export async function writeConsoleAuthHandlers(root: string, config: ResolvedCloudflareAccessConsoleAuth, mountBaseURL?: string, mcpResource?: string): Promise<CloudflareAccessConsoleAuthHandlers>
export async function writeConsoleAuthHandlers(root: string, config: ResolvedConsoleAuthFiles | InlineConsoleAuth, mountBaseURL?: string, mcpResource?: string): Promise<SessionConsoleAuthHandlers>
export async function writeConsoleAuthHandlers(root: string, config: ResolvedConsoleAuthConfig, mountBaseURL?: string, mcpResource?: string): Promise<ConsoleAuthHandlers>
export async function writeConsoleAuthHandlers(root: string, config: ResolvedConsoleAuthConfig, mountBaseURL = "/", mcpResource?: string): Promise<ConsoleAuthHandlers> {
  const directory = resolve(root, ".vitehub/nitro/console")
  if ("settings" in config) return writeCloudflareAccessMiddleware(root, config, mountBaseURL)
  const definitionFile = resolve(directory, "auth-definition.mjs")
  const route = resolve(directory, "auth-route.mjs")
  const signIn = resolve(directory, "auth-sign-in.mjs")
  const middleware = consoleAuthMiddlewareFile(root)
  const inline = "provider" in config
  const mountBase = consoleAuthMountBase(mountBaseURL)
  await Promise.all([
    writeFileIfChanged(definitionFile, [
      ...(inline
        ? [
            `import { createInlineConsoleAuth } from ${JSON.stringify(generatedModules.consoleAuthInline)}`,
            `export const input = createInlineConsoleAuth(${JSON.stringify(config)})`,
          ]
        : [
            `import input from ${JSON.stringify(pathToFileURL(config.server).href)}`,
            "export { input }",
          ]),
      'import { toAuthRequest } from "#vitehub/auth/server"',
      'import { createConsoleAuthDefinition, prepareConsoleAuth } from "vite-hub/console/auth"',
      `export const definition = createConsoleAuthDefinition(input, ${JSON.stringify(mountBaseURL)}${mcpResource ? `, ${JSON.stringify(mcpResource)}` : ""})`,
      "export const signInProvider = input.signIn.provider",
      "export function prepare(event) { return prepareConsoleAuth(input, definition, toAuthRequest(event), event) }",
      "",
    ].join("\n")),
    // Fetchable routes (https://fetchable.org). In a ViteHub app, the Request carries the Standard Context of the request.
    writeFileIfChanged(route, [
      'import { handleAuthRequest } from "#vitehub/auth/server"',
      'import { definition, prepare } from "./auth-definition.mjs"',
      "export default {",
      "  async fetch(request) {",
      "    await prepare(request)",
      "    return handleAuthRequest(definition, request, undefined, request)",
      "  },",
      "}",
      "",
    ].join("\n")),
    writeFileIfChanged(signIn, [
      'import { consoleAuthPageResponse, consoleAuthSignInPage, consoleSignedInPage } from "vite-hub/console/auth"',
      'import { prepare, signInProvider } from "./auth-definition.mjs"',
      'import { checkConsoleAccess, readConsoleUser } from "./auth-middleware.mjs"',
      "export default {",
      "  async fetch(request) {",
      "    const url = new URL(request.url)",
      "    // MCP login and consent must keep their signed-query continuation, including for an existing session.",
      `    if (url.searchParams.has("sig") && url.searchParams.has("client_id")) return consoleAuthSignInPage(signInProvider, request, ${JSON.stringify(mountBaseURL)})`,
      "    await prepare(request)",
      `    if (!await readConsoleUser(request)) return consoleAuthSignInPage(signInProvider, request, ${JSON.stringify(mountBaseURL)})`,
      "    const denied = await checkConsoleAccess(request)",
      `    if (denied) return consoleAuthPageResponse(request, denied, ${JSON.stringify(mountBaseURL)}) ?? denied`,
      "    return consoleSignedInPage(url)",
      "  },",
      "}",
      "",
    ].join("\n")),
    writeFileIfChanged(middleware, [
      'import { createAuthForRequest, requireAuthAccessRoutes, toAuthRequest, withAuthorization } from "#vitehub/auth/server"',
      'import { consoleAuthPageResponse, consoleAuthSignInURLs, readConsoleSessionUser } from "vite-hub/console/auth"',
      'import { definition, input, prepare } from "./auth-definition.mjs"',
      "const authorizeConsoleAccess = withAuthorization(input.authorize, () => undefined, definition)",
      "// Each Console data route calls this check, whatever its path. It never redirects to sign-in.",
      "export async function checkConsoleAccess(event) {",
      "  await prepare(event)",
      "  return authorizeConsoleAccess(event)",
      "}",
      "// Bearer identities have no browser session; keep the Console Auth allowlist in force.",
      "export function authorizeConsoleBearer({ request, user }) {",
      "  return input.authorize({ request, user, session: {} })",
      "}",
      "// The Better Auth instance of Console Auth. MCP access tokens are checked against its keys and users in-process.",
      "export function createConsoleAuth(request, event) {",
      "  return createAuthForRequest(definition, request, undefined, event)",
      "}",
      "// The signed-in Console Auth user, for console.authorize and Connections activity.",
      "export function readConsoleUser(event) {",
      "  const request = toAuthRequest(event)",
      "  return readConsoleSessionUser(createAuthForRequest(definition, request, undefined, event), request)",
      "}",
      "export default async function viteHubConsoleAuthMiddleware(event) {",
      `  const mountBase = ${JSON.stringify(mountBase)}`,
      "  const request = toAuthRequest(event)",
      "  const url = new URL(request.url)",
      "  const publicPath = url.pathname",
      "  const path = mountBase && publicPath.startsWith(`${mountBase}/`) ? publicPath.slice(mountBase.length) : publicPath",
      "  // Page tools apply their own visitor and API authorization, independently of the Console.",
      "  if (path === '/_vitehub/page/session' || path.startsWith('/_vitehub/page/assets/')) return",
      "  if (path === '/_vitehub/api/auth' || path.startsWith('/_vitehub/api/auth/')) return",
      "  if (path === '/_vitehub/sign-in') return",
      "  // The exact mounted MCP route verifies bearer tokens and returns OAuth discovery challenges.",
      "  if (publicPath === `${mountBase}/_vitehub/mcp`) { await prepare(event); return }",
      "  if (!(path === '/_vitehub' || path.startsWith('/_vitehub/'))) return",
      "  await prepare(event)",
      "  // The Console API answers 401 to a signed-out request, where a Console page goes to the sign-in page.",
      "  if (path === '/_vitehub/api' || path.startsWith('/_vitehub/api/')) return requireAuthAccessRoutes(event, [1], definition, [1], { redirectToSignIn: false })",
      "  return consoleAuthPageResponse(request, await requireAuthAccessRoutes(event, [0], definition, [0], { redirectToSignIn: path === '/_vitehub' && url.searchParams.has('auth_start'), signIn: consoleAuthSignInURLs(request, mountBase) }), mountBase)",
      "}",
      "",
    ].join("\n")),
  ])
  return { auth: true, middleware, route, signIn }
}

/** Module id that the generated Connections management handler imports to identify the actor. */
export const consoleConnectionsActorId = "#vitehub/console/connections-actor"

/** Write the Connections access policy module. It checks each management request with the Console access policy. */
export async function writeConsoleConnectionsActor(root: string, sessionActorModule?: string): Promise<string> {
  const file = resolve(root, ".vitehub/nitro/console/connections-actor.mjs")
  await writeFileIfChanged(file, [
    `import { consoleConnectionsActor } from ${JSON.stringify(generatedModules.consoleSections)}`,
    ...(sessionActorModule ? [`import { readConsoleUser } from ${JSON.stringify(pathToFileURL(sessionActorModule).href)}`] : []),
    // The Request carries the Standard Context of the event, so the Console access policy reads it like an event.
    "export default function viteHubConsoleConnectionsActor(request) {",
    `  return consoleConnectionsActor(request${sessionActorModule ? ', async () => { const user = await readConsoleUser(request); return user ? "user:" + user.id : undefined }' : ''})`,
    "}",
    "",
  ].join("\n"))
  return file
}
