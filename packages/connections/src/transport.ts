import { isApiKeyProvider } from "./api-key.ts"
import { ConnectionError } from "./errors.ts"
import { providerApis } from "./catalog.ts"

import type { RequestScheduler } from "./requests.ts"
import type { ConnectionDefinition } from "./types.ts"

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Whether `url` is the provider's `mcp` endpoint. Trailing slashes and the query do not count. */
function isMcpEndpoint(endpoint: string | undefined, url: string): boolean {
  if (!endpoint) return false
  const declared = new URL(endpoint)
  const target = new URL(url)
  return target.origin === declared.origin && target.pathname.replace(/\/+$/, "") === declared.pathname.replace(/\/+$/, "")
}

/** Own credential destinations and headers for both catalog and raw requests. */
export function createConnectionTransport(name: string, definition: ConnectionDefinition, request: typeof fetch, scheduler: RequestScheduler) {
  const provider = definition.provider
  const header = isApiKeyProvider(provider) ? provider.header : "authorization"
  const policy = provider.requests ? scheduler.resolve(name, provider.requests) : undefined

  // Preparation also runs before governance so an unsafe destination cannot create an approval.
  function prepare(url: string | URL, input?: RequestInit["headers"]): Record<string, string> {
    const origin = new URL(url).origin
    const origins = Object.values(providerApis(definition)).map(catalog => new URL(catalog.rootUrl).origin)
    if (isApiKeyProvider(provider)) origins.push(...provider.origins)
    if (provider.mcp) origins.push(new URL(provider.mcp).origin)
    if (!origins.includes(origin)) {
      throw new ConnectionError("invalid", `Connection "${name}" does not send its token to ${origin}.`, { details: { connection: name } })
    }
    const headers = new Headers(input)
    headers.delete("authorization")
    headers.delete(header)
    // Never forward caller-controlled response-cookie data through provider redirects.
    headers.delete("set-cookie")
    return Object.fromEntries(headers)
  }

  async function send(url: string, token: { accessToken: string, tokenType: string }, init: RequestInit & { json?: boolean }): Promise<Response> {
    const headers = new Headers({ accept: "application/json", ...prepare(url, init.headers) })
    const scheme = isApiKeyProvider(provider) ? provider.scheme : token.tokenType === "bearer" ? "Bearer" : token.tokenType
    headers.set(header, scheme ? `${scheme} ${token.accessToken}` : token.accessToken)
    const { json, ...requestInit } = init
    if (json && init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    const authenticated = { ...requestInit, headers }
    const dispatch = (attempt: RequestInit) => isApiKeyProvider(provider) ? sendKey(url, attempt) : request(url, attempt)
    // MCP sessions are long-lived streams, so the request policy does not pace, retry, or time them out.
    return await (policy && !isMcpEndpoint(provider.mcp, url) ? scheduler.send(policy, authenticated, dispatch) : dispatch(authenticated))
  }

  /**
   * Send a request that carries an API key. Fetch keeps custom headers on a cross-origin redirect,
   * so ViteHub follows redirects itself and removes the key once the chain leaves the first origin.
   */
  async function sendKey(url: string, init: RequestInit): Promise<Response> {
    if (init.redirect && init.redirect !== "follow") return await request(url, init)
    const origin = new URL(url).origin
    let target = new URL(url)
    let current = init
    let crossed = false
    for (let hop = 0; ; hop += 1) {
      crossed ||= target.origin !== origin
      const headers = new Headers(current.headers)
      if (crossed) {
        headers.delete(header)
        for (const credentialHeader of ["authorization", "cookie", "proxy-authorization", "set-cookie"]) headers.delete(credentialHeader)
      }
      const response = await request(target.toString(), { ...current, headers, redirect: "manual" })
      const location = response.headers.get("location")
      if (!REDIRECT_STATUSES.has(response.status) || !location || hop === MAX_REDIRECTS) return response
      await response.body?.cancel().catch(() => undefined)
      const method = (current.method ?? "GET").toUpperCase()
      // Fetch turns a 303, and a 301 or 302 after POST, into GET without a body.
      if ((response.status === 303 && method !== "GET" && method !== "HEAD") || ((response.status === 301 || response.status === 302) && method === "POST")) {
        headers.delete("content-type")
        headers.delete("content-length")
        current = { ...current, body: undefined, headers, method: "GET" }
      }
      else {
        current = { ...current, headers }
      }
      target = new URL(location, target)
    }
  }

  return { prepare, send }
}
