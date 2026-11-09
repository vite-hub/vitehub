import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import type { ViteHubContext } from "@vite-hub/runtime"
import type { AuthRequest, AuthRequestInput } from "./types.ts"

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function")
}

/** A Web Request, also from another realm. A request event has no string `url` and `method` of its own. */
function isAuthRequest(input: AuthRequestInput): input is AuthRequest {
  if (input instanceof Request) return true
  if ("~standard" in input) return false
  const headers: unknown = Reflect.get(input, "headers")
  return typeof Reflect.get(input, "url") === "string"
    && typeof Reflect.get(input, "method") === "string"
    && isObjectLike(headers)
    && typeof Reflect.get(headers, "get") === "function"
}

/** Return a Web Request itself, or the request in the Standard Context of a request event. */
export function unwrapAuthRequest(input: AuthRequestInput): AuthRequest {
  return isAuthRequest(input) ? input : getStandardContext(input).req
}

/**
 * Return the object that carries the Standard Context of an Auth input: the request event, or the Web Request itself.
 * A Request that no framework wrapped gets a Standard Context that reads the host data on it, such as srvx `ip` and
 * `runtime.cloudflare`.
 */
export function authRequestEvent(input: AuthRequestInput): ViteHubContext {
  // SAFETY: An Auth input is a request event or a Web Request. getStandardContext() sets `~standard` on a Request.
  const value = input as Request | ViteHubContext
  getStandardContext(value)
  return value as ViteHubContext
}

/** The Cloudflare bindings in the Standard Context of `event`, else the bindings of the active Cloudflare request. */
export function authCloudflareEnv(event?: ViteHubContext): Record<string, unknown> | undefined {
  return (event ? getStandardContext(event).runtime?.cloudflare?.env : undefined) ?? getActiveCloudflareEnv()
}
