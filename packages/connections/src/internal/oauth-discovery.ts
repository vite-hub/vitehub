import * as v from "valibot"

import { isSafeEndpoint } from "../api-key.ts"
import { connectionsErrorDiagnostics } from "../error-diagnostics.ts"

import type { EnvSecretStore } from "@vite-hub/env/bridge"

const DISCOVERY_TIMEOUT_MS = 30_000

/** The authorization server of an MCP endpoint, from its metadata. */
export interface AuthorizationServer {
  authorizationEndpoint: string
  issuer: string
  registrationEndpoint?: string
  /** The RFC 8707 resource of the MCP endpoint, from its protected resource metadata. */
  resource: string
  revocationEndpoint?: string
  tokenEndpoint: string
}

/** A client that ViteHub registered at an authorization server (RFC 7591). */
export interface RegisteredClient {
  clientId: string
  clientSecret?: string
  /** When the client secret expires, in milliseconds. */
  secretExpiresAt?: number
}

const safeEndpoint = v.pipe(v.string(), v.check(isSafeEndpoint))
const resourceMetadataSchema = v.object({
  resource: v.optional(v.string()),
  authorization_servers: v.optional(v.array(v.string())),
})
const serverMetadataSchema = v.object({
  issuer: v.pipe(v.string(), v.minLength(1)),
  authorization_endpoint: safeEndpoint,
  token_endpoint: safeEndpoint,
  registration_endpoint: v.optional(safeEndpoint),
  revocation_endpoint: v.optional(safeEndpoint),
})
const registrationSchema = v.object({
  client_id: v.pipe(v.string(), v.minLength(1)),
  client_secret: v.optional(v.string()),
  client_secret_expires_at: v.optional(v.number()),
})
const storedClientSchema = v.object({
  clientId: v.pipe(v.string(), v.minLength(1)),
  clientSecret: v.optional(v.string()),
  secretExpiresAt: v.optional(v.number()),
})

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

async function challengeMetadataUrl(mcp: string, request: typeof fetch): Promise<string | undefined> {
  try {
    const response = await request(mcp, { headers: { accept: "application/json, text/event-stream" }, redirect: "manual", signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
    await response.body?.cancel()
    if (response.status !== 401) return undefined
    const url = /\bresource_metadata="([^"]+)"/i.exec(response.headers.get("www-authenticate") ?? "")?.[1]
    return url && isSafeEndpoint(url) ? url : undefined
  }
  catch {
    return undefined
  }
}

function resourceMetadataUrls(resource: string): string[] {
  const url = new URL(resource)
  const path = withoutTrailingSlash(url.pathname)
  return [...new Set([`${url.origin}/.well-known/oauth-protected-resource${path}`, `${url.origin}/.well-known/oauth-protected-resource`])]
}

function serverMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer)
  const path = withoutTrailingSlash(url.pathname)
  if (!path) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`]
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ]
}

async function readJson(request: typeof fetch, url: string, init: RequestInit = {}): Promise<{ body: unknown, status: number } | undefined> {
  try {
    const response = await request(url, {
      ...init,
      headers: { accept: "application/json", ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    return { body: await response.json().catch(() => undefined), status: response.status }
  }
  catch {
    return undefined
  }
}

/**
 * Find the authorization server of an MCP endpoint as the MCP authorization spec does: its protected resource metadata
 * names the server (RFC 9728), and the server's metadata lists its endpoints (RFC 8414 or OpenID Connect discovery).
 * Without resource metadata, the origin of the MCP endpoint is the authorization server.
 */
export async function discoverAuthorizationServer(mcp: string, request: typeof fetch, connection: string): Promise<AuthorizationServer> {
  let issuer: string | undefined
  let resource = mcp
  const advertised = await challengeMetadataUrl(mcp, request)
  for (const url of [...(advertised ? [advertised] : []), ...resourceMetadataUrls(mcp)]) {
    const response = await readJson(request, url)
    const metadata = response && response.status < 300 ? v.safeParse(resourceMetadataSchema, response.body) : undefined
    if (!metadata?.success) continue
    issuer = metadata.output.authorization_servers?.[0]
    const named = metadata.output.resource
    if (named && URL.canParse(named) && new URL(named).origin === new URL(mcp).origin) resource = named
    break
  }
  issuer ??= new URL(mcp).origin
  if (!isSafeEndpoint(issuer)) {
    throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ message: `authorization server for ${mcp}`, problem: "discovery", provider: connection })
  }
  for (const url of serverMetadataUrls(issuer)) {
    const response = await readJson(request, url)
    const metadata = response && response.status < 300 ? v.safeParse(serverMetadataSchema, response.body) : undefined
    if (!metadata?.success || withoutTrailingSlash(metadata.output.issuer) !== withoutTrailingSlash(issuer)) continue
    const server = metadata.output
    return {
      authorizationEndpoint: server.authorization_endpoint,
      issuer: server.issuer,
      resource,
      tokenEndpoint: server.token_endpoint,
      ...(server.registration_endpoint ? { registrationEndpoint: server.registration_endpoint } : {}),
      ...(server.revocation_endpoint ? { revocationEndpoint: server.revocation_endpoint } : {}),
    }
  }
  throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ message: `authorization server metadata at ${issuer}`, problem: "discovery", provider: connection })
}

async function clientKey(issuer: string, redirectUri: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${withoutTrailingSlash(issuer)}\n${redirectUri}`)))
  return `connections-client/${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`
}

export interface ClientRegistrations {
  /**
   * The client registered at `server` for `redirectUri`. It registers one the first time, and again after
   * `forget()` or when the client secret expired. Concurrent callers share the client that is stored first.
   */
  client: (server: AuthorizationServer, input: { clientName: string, connection: string, redirectUri: string, scopes: readonly string[] }) => Promise<RegisteredClient & { key: string }>
  /** Forget a client that the authorization server rejected, so the next sign-in registers a new one. */
  forget: (key: string, clientId: string) => Promise<void>
  /** The client stored under `key`, if any. */
  stored: (key: string) => Promise<RegisteredClient | undefined>
}

/** Registered clients, sealed in the Connections secret store under `connections-client/<hash>`. */
export function clientRegistrations(options: { now: () => number, request: typeof fetch, secrets: () => Promise<EnvSecretStore> }): ClientRegistrations {
  const { now, request } = options

  async function read(key: string): Promise<{ client?: RegisteredClient, revision: string | null }> {
    const stored = await (await options.secrets()).read(key)
    if (!stored) return { revision: null }
    let value: unknown
    try {
      value = JSON.parse(stored.value)
    }
    catch {}
    const client = v.safeParse(storedClientSchema, value)
    return { ...(client.success ? { client: client.output } : {}), revision: stored.revision ?? null }
  }

  const usable = (client: RegisteredClient | undefined): client is RegisteredClient =>
    client !== undefined && (!client.secretExpiresAt || client.secretExpiresAt > now() + 60_000)

  return {
    async client(server, input) {
      const key = await clientKey(server.issuer, input.redirectUri)
      const current = await read(key)
      if (usable(current.client)) return { ...current.client, key }
      if (!server.registrationEndpoint) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_DEFINITION({ connection: input.connection, problem: "registration" })
      const loopback = new URL(input.redirectUri).protocol === "http:"
      const response = await readJson(request, server.registrationEndpoint, {
        body: JSON.stringify({
          application_type: loopback ? "native" : "web",
          client_name: input.clientName,
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [input.redirectUri],
          response_types: ["code"],
          ...(input.scopes.length ? { scope: input.scopes.join(" ") } : {}),
          token_endpoint_auth_method: "none",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      const registration = response && response.status < 300 ? v.safeParse(registrationSchema, response.body) : undefined
      if (!registration?.success) {
        throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ problem: "registration", provider: input.connection, status: response?.status })
      }
      const expiresAt = registration.output.client_secret_expires_at
      const client: RegisteredClient = {
        clientId: registration.output.client_id,
        ...(registration.output.client_secret ? { clientSecret: registration.output.client_secret } : {}),
        ...(expiresAt ? { secretExpiresAt: expiresAt * 1000 } : {}),
      }
      const secrets = await options.secrets()
      try {
        await secrets.replace({ expectedRevision: current.revision, key, value: JSON.stringify(client) })
        return { ...client, key }
      }
      catch (error) {
        const winner = await read(key)
        if (!usable(winner.client)) throw error
        return { ...winner.client, key }
      }
    },
    stored: async key => (await read(key)).client,
    async forget(key, clientId) {
      const current = await read(key)
      if (current.client?.clientId !== clientId || current.revision === null) return
      await (await options.secrets()).replace({ expectedRevision: current.revision, key, value: JSON.stringify({ forgotten: clientId }) }).catch(() => undefined)
    },
  }
}
