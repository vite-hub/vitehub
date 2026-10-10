import { SecretEnv } from "@vite-hub/env/secret"
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose"

import type { EnvVariableDeclaration } from "@vite-hub/env"
import { cloudflareAccessIssuer, consoleAuthMountBase } from "./auth-path.ts"

/** Cloudflare Access settings for an independent Console Auth provider. */
export interface CloudflareAccessConsoleAuth {
  provider: "cloudflare-access"
  /** Access team domain, such as `acme.cloudflareaccess.com`. Defaults to Env `CF_ACCESS_TEAM_DOMAIN`. */
  teamDomain?: string | EnvVariableDeclaration
  /** Application Audience (AUD) tag of the Access application. Defaults to Env `CF_ACCESS_AUD`. */
  audience?: string | EnvVariableDeclaration
}

/** Identity that Cloudflare Access asserts for a Console request. */
export interface CloudflareAccessIdentity {
  /** Email of a user who signed in through an identity provider. */
  email?: string
  /** Client ID of a service token. */
  commonName?: string
}

export interface CloudflareAccessVerifierOptions {
  fetch?: typeof fetch
}

export type CloudflareAccessVerifier = (
  token: string,
  settings: { audience: string, issuer: string },
) => Promise<CloudflareAccessIdentity | undefined>

export const cloudflareAccessAssertionHeader = "cf-access-jwt-assertion"
export const cloudflareAccessSignOutPath = "/cdn-cgi/access/logout"
export const cloudflareAccessIdentityPath = "/api/_vitehub/console/auth/identity"
const cloudflareAccessJwksCooldown = 1_000

/**
 * Create a verifier for Cloudflare Access application tokens. Each verifier keeps one remote key set per issuer,
 * so it fetches `/cdn-cgi/access/certs` once and again only when the cache expires or a token uses an unknown key.
 */
export function createCloudflareAccessVerifier(options: CloudflareAccessVerifierOptions = {}): CloudflareAccessVerifier {
  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
  const pendingFetches = new Map<string, Promise<Response>>()
  const fetchImpl = options.fetch ?? globalThis.fetch
  const fetchKeys: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const key = `${method}:${url}`
    let pending = pendingFetches.get(key)
    if (!pending) {
      pending = fetchImpl(input, init).finally(() => pendingFetches.delete(key))
      pendingFetches.set(key, pending)
    }
    return (await pending).clone()
  }
  return async (token, { audience, issuer }) => {
    let keys = keySets.get(issuer)
    if (!keys) {
      keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), {
        cooldownDuration: cloudflareAccessJwksCooldown,
        [customFetch]: fetchKeys,
      })
      keySets.set(issuer, keys)
    }
    try {
      const { payload } = await jwtVerify(token, keys, { algorithms: ["RS256"], audience, issuer })
      const identity: CloudflareAccessIdentity = {}
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JWT claims are untrusted JSON values.
      if (typeof payload.email === "string" && payload.email) identity.email = payload.email
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JWT claims are untrusted JSON values.
      if (typeof payload.common_name === "string" && payload.common_name) identity.commonName = payload.common_name
      return identity
    }
    catch {
      return undefined
    }
  }
}

const defaultVerifier = createCloudflareAccessVerifier()

function settingValue(value: unknown): string | undefined {
  const resolved = value instanceof SecretEnv ? value.unseal() : value
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Resolved Env values cross the generated runtime boundary.
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    status,
  })
}

type CloudflareAccessCheck = { identity: CloudflareAccessIdentity, response?: undefined } | { identity?: undefined, response: Response }

async function checkCloudflareAccessToken(
  request: Request,
  resolveSettings: () => { audience?: unknown, teamDomain?: unknown },
  verify: CloudflareAccessVerifier,
): Promise<CloudflareAccessCheck> {
  let settings: { audience?: unknown, teamDomain?: unknown }
  try {
    settings = resolveSettings()
  }
  catch {
    settings = {}
  }
  const teamDomain = settingValue(settings.teamDomain)
  const issuer = teamDomain ? cloudflareAccessIssuer(teamDomain) : undefined
  const audience = settingValue(settings.audience)
  if (!issuer || !audience) {
    return { response: textResponse("Cloudflare Access Console Auth requires a valid team domain and audience.", 500) }
  }
  const token = request.headers.get(cloudflareAccessAssertionHeader)
  if (!token) return { response: textResponse("Cloudflare Access did not authenticate this request.", 401) }
  const identity = await verify(token, { audience, issuer })
  if (!identity) return { response: textResponse("The Cloudflare Access token is not valid for this Console.", 401) }
  return { identity }
}

/**
 * Check one Console data request with the Cloudflare Access application token, whatever its path.
 * Returns a rejection response, or `undefined` when the request continues to its handler.
 */
export async function verifyCloudflareAccessConsoleRequest(
  request: Request,
  resolveSettings: () => { audience?: unknown, teamDomain?: unknown },
  verify: CloudflareAccessVerifier = defaultVerifier,
): Promise<Response | undefined> {
  return (await checkCloudflareAccessToken(request, resolveSettings, verify)).response
}

/**
 * Guard Console routes with the Cloudflare Access application token. Returns a response for a rejected request or
 * the identity route, and `undefined` when the request continues to its handler.
 */
export async function handleCloudflareAccessConsoleRequest(
  event: { req: Request, url: URL },
  resolveSettings: () => { audience?: unknown, teamDomain?: unknown },
  mountBaseURL = "/",
  verify: CloudflareAccessVerifier = defaultVerifier,
): Promise<Response | undefined> {
  const mountBase = consoleAuthMountBase(mountBaseURL)
  const publicPath = event.url.pathname
  const path = mountBase && publicPath.startsWith(`${mountBase}/`) ? publicPath.slice(mountBase.length) : publicPath
  if (!(path === "/_vitehub" || path.startsWith("/_vitehub/") || path === "/api/_vitehub/console" || path.startsWith("/api/_vitehub/console/"))) return
  const { identity, response } = await checkCloudflareAccessToken(event.req, resolveSettings, verify)
  if (response) return response
  if (path === cloudflareAccessIdentityPath) {
    if (event.req.method !== "GET") return textResponse("Method not allowed.", 405)
    return Response.json({ ...identity, signOutURL: cloudflareAccessSignOutPath }, { headers: { "cache-control": "no-store" } })
  }
}
