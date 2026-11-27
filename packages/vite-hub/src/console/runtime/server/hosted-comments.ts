import { consolePublicKeyPrefix, readConsolePublicKeys } from "@vite-hub/internal/console-signature"
import { injectViteHubPageScript } from "@vite-hub/internal/runtime/page-tools"
import { viteHubPageToolsLinkParams, viteHubPageToolsMarker, viteHubPageToolsQuery } from "@vite-hub/internal/runtime/page-tools-shared"
import { forwardedRequestOrigin, matchesPublicOrigin } from "@vite-hub/internal/runtime/request-origin"
import { configuredConsoleOrigin } from "@vite-hub/runtime/internal/console"
import { configuredPublicOrigins } from "@vite-hub/runtime/internal/public-url"

import { consoleRequestEnv } from "./console-signature.ts"

const hostedCommentsAttribute = "data-vitehub-hosted-comments"

/**
 * The Console public keys of the app: the values of its `VITEHUB_CONSOLE_KEY_<NAME>` variables. An app with none, or
 * with a malformed one, is not linked, and gets no Hosted Comments.
 */
export function hostedCommentsKeys(env: Readonly<Record<string, unknown>>): string[] {
  const keys = readConsolePublicKeys(env)
  if (!(keys instanceof Map)) return []
  return [...keys.keys()].flatMap((name) => {
    const value = env[`${consolePublicKeyPrefix}${name}`]
    return typeof value === "string" ? [value.trim()] : []
  })
}

function scriptValue(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

/**
 * The inline loader of the Hosted Comments pill. It is a classic script, so it can give its nonce to the module script
 * that it adds. The tag has `data-vitehub-page-tools`, so a page gets one page tools script only.
 */
export function hostedCommentsLoader(consoleOrigin: string, keys: readonly string[], nonce?: string): string {
  const params = scriptValue([viteHubPageToolsQuery, ...viteHubPageToolsLinkParams])
  const source = scriptValue(new URL("/hosted-comments.js", consoleOrigin).href)
  const body = `(()=>{let s=!1;try{for(let i=0;i<sessionStorage.length;i++)s||=sessionStorage.key(i)?.startsWith("vitehub-comments:")===!0}catch{}const q=new URLSearchParams(location.search);if(!s&&!${params}.some(p=>q.has(p))&&!/^#\\/?vhc=/.test(location.hash))return;const e=document.createElement("script");e.type="module";e.src=${source};e.dataset.vitehubConsoleKey=${scriptValue(keys.join(" "))};e.nonce=document.currentScript?.nonce??"";document.head.append(e)})()`
  return `<script ${hostedCommentsAttribute}${nonce ? ` nonce="${nonce}"` : ""} ${viteHubPageToolsMarker}>${body}</script>`
}

function isPagePath(url: URL): boolean {
  return !/\/_vitehub(?=\/|$)/.test(url.pathname)
}

function isLoopback(request: Request): boolean {
  const { hostname } = new URL(forwardedRequestOrigin(request))
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Adds the Hosted Comments loader to an HTML page of an app without app Comments, on the public origins of the app and
 * for the prerenderer. In the browser, the loader loads `<console>/hosted-comments.js` only when the page asks for the
 * pill. That script finds the Console project from the public keys of the app, and the Console keeps the comments. Other responses, and every response of an app without Console keys, return unchanged. The Console
 * frame opens only on the project origin, so a page on this computer, such as on a development server, gets no loader.
 */
export function withHostedComments(request: Request, response: Response): Response {
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) return response
  if (!isPagePath(new URL(request.url))) return response
  if (!request.headers.has("x-nitro-prerender") && (isLoopback(request) || !matchesPublicOrigin(request, configuredPublicOrigins()))) return response
  const keys = hostedCommentsKeys(consoleRequestEnv(request))
  if (!keys.length) return response
  const consoleOrigin = configuredConsoleOrigin()
  return injectViteHubPageScript(response, nonce => hostedCommentsLoader(consoleOrigin, keys, nonce))
}
