import { readConsolePublicKeys } from "@vite-hub/internal/console-signature"
import { verifySiteToken } from "@vite-hub/internal/site-token"
import { resolvePublicUrl } from "@vite-hub/runtime"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"

/** The cookie of a browser that Site access signed in: the state and the token, `<state>.<token>`. */
export const siteCookie = "__Host-vitehub-site"
/** Seconds that a browser stays signed in after the Console signed its token. */
export const siteSessionLifetime: number = 12 * 60 * 60
/** The length of the state part of the site cookie. */
export const siteStateLength = 43

/** The value of the cookie `name` of a request. */
export function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

function siteApp(request: Request, base: string, development: boolean): string | undefined {
  const origin = development ? request.url : resolvePublicUrl({ request })
  return origin ? `${new URL(origin).origin}${base.replace(/\/+$/, "")}` : undefined
}

const visitors = new WeakMap<Request, Promise<ViteHubSiteVisitor | undefined>>()

async function readVisitor(request: Request, base: string, development: boolean): Promise<ViteHubSiteVisitor | undefined> {
  const value = cookieValue(request, siteCookie)
  if (!value || value[siteStateLength] !== ".") return undefined
  const keys = readConsolePublicKeys({ ...globalThis.process?.env, ...getStandardContext(request).runtime?.cloudflare?.env })
  if (!(keys instanceof Map)) return undefined
  let app: string | undefined
  try {
    app = siteApp(request, base, development)
  }
  catch {
    return undefined
  }
  if (!app) return undefined
  const result = await verifySiteToken({ token: value.slice(siteStateLength + 1), keys, origin: app, state: value.slice(0, siteStateLength), lifetime: siteSessionLifetime })
  if (!result.ok) return undefined
  const { sub, name, email, image, roles } = result.claims
  return { id: sub, name, ...(email ? { email } : {}), ...(image ? { image } : {}), roles, kind: roles.includes("console") ? "member" : "guest" }
}

/**
 * The person of the site cookie of a request, or `undefined` without a cookie, or with one that the public keys of the
 * app do not verify, that was made for another app, or that is older than 12 hours. `base` is the app base, such as
 * `/portal/`. A development server checks the token against the request origin. Each Request is checked once.
 */
export function readConsoleSiteVisitor(request: Request, base = "", development: boolean = isConsoleDevelopmentBuild()): Promise<ViteHubSiteVisitor | undefined> {
  let visitor = visitors.get(request)
  if (!visitor) {
    visitor = readVisitor(request, base, development)
    visitors.set(request, visitor)
  }
  return visitor
}
