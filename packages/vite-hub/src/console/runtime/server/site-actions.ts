import { consoleImpersonation } from "./access.ts"
import { consoleRequestError, type ConsoleRequestEvent } from "./request.ts"
import { loadConsoleRuntime } from "./runtime.ts"
import { getConsoleSections } from "./sections.ts"
import { html, seeOther, siteFailurePage, sitePageHeaders, siteProblemPage } from "./site-pages.ts"

import type { AuthConsole } from "@vite-hub/auth/console-runtime"
import type { SiteTokenMatch } from "@vite-hub/internal/site-token"

async function authConsole(request: Request, event: ConsoleRequestEvent): Promise<AuthConsole | undefined> {
  if (!getConsoleSections().includes("auth")) return undefined
  const auth = import.meta.viteHubConsoleAuth === false ? undefined : await import("@vite-hub/auth/server")
  return auth?.getAuthConsoleForRequest(request, event, { impersonation: true })
}

async function authFailure(error: Parameters<typeof import("../../../auth/console/auth.ts").authConsoleFailure>[0]): Promise<unknown> {
  const auth = import.meta.viteHubConsoleAuth === false ? undefined : await import("../../../auth/console/auth.ts")
  return auth ? auth.authConsoleFailure(error) : error
}

function refused(message: string, headers: Headers): Response {
  return siteProblemPage(401, "CONSOLE_SITE_TOKEN_REFUSED", message, undefined, headers)
}

async function impersonate(match: SiteTokenMatch, request: Request, event: ConsoleRequestEvent, home: string, headers: Headers): Promise<Response> {
  if (!consoleImpersonation()) return siteFailurePage(consoleRequestError(404, "Impersonation is off. Set console.impersonation to true to enable it."), headers)
  const api = await authConsole(request, event)
  if (!api) return siteFailurePage(consoleRequestError(404, "The app has no Auth section."), headers)
  const email = match.claims.email?.toLowerCase()
  if (!email) return siteFailurePage(consoleRequestError(403, "Impersonation checks that the browser is signed in to the app with the email of your Console account, and the token has no email.", "CONSOLE_ACCESS_DENIED"), headers)
  const [sessionError, session] = await api.session(request)
  if (sessionError) throw sessionError
  if (!session) return siteProblemPage(403, "CONSOLE_SITE_ACCOUNT_MISMATCH", `Sign in to the app as ${email}, an account that may impersonate users, then start again from the Console.`, undefined, headers)
  const { action, userId } = match.claims.target ?? {}
  if (action === "stop") {
    if (!session.impersonatedBy) return siteFailurePage(consoleRequestError(409, "This browser does not impersonate a user."), headers)
    if (session.impersonatedBy.email.toLowerCase() !== email) return siteProblemPage(403, "CONSOLE_SITE_ACCOUNT_MISMATCH", `This browser impersonates for ${session.impersonatedBy.email || "another administrator"}, and the token was made for ${email}.`, undefined, headers)
    const [error, response] = await api.stopImpersonating(request)
    if (error) return siteFailurePage(await authFailure(error), headers)
    return seeOther(home, mergeCookies(response.headers, headers))
  }
  if (action !== "start" || !userId) return refused("The impersonation token names no user.", headers)
  if (session.user.email.toLowerCase() !== email) return siteProblemPage(403, "CONSOLE_SITE_ACCOUNT_MISMATCH", `This browser is signed in to the app as ${session.user.email}, and the token was made for ${email}. Sign in to the app as ${email}, then start again from the Console.`, undefined, headers)
  const [error, response] = await api.execute({ action: "impersonate", userId }, request)
  if (error) return siteFailurePage(await authFailure(error), headers)
  return seeOther(home, mergeCookies(response.headers, headers))
}

function mergeCookies(first: Headers, second: Headers): Headers {
  const out = new Headers()
  for (const cookie of [...first.getSetCookie(), ...second.getSetCookie()]) out.append("set-cookie", cookie)
  return out
}

async function sha256Base64(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return btoa(String.fromCharCode(...digest))
}

async function openPreview(match: SiteTokenMatch, headers: Headers): Promise<Response> {
  const { collection, id, section } = match.claims.target ?? {}
  if (!collection || !id || !section) return refused("The preview token names no document.", headers)
  const documents = await (import.meta.viteHubConsoleDocuments === false
    ? Promise.reject(consoleRequestError(404, "The Console document editor section is disabled."))
    : import("./documents.ts"))
  const actions = await documents.loadConsoleDocumentActions(section)
  const { claims } = match
  const user = { id: claims.sub, name: claims.name, ...(claims.email ? { email: claims.email.toLowerCase() } : {}), ...(claims.image ? { image: claims.image } : {}) }
  const preview: unknown = await documents.runConsoleDocumentAction(() => actions.preview({ collection, id }, { user }))
  const parameter: unknown = Reflect.get(Object(preview), "parameter")
  const token: unknown = Reflect.get(Object(preview), "token")
  if (String(parameter) !== parameter || String(token) !== token) throw consoleRequestError(409, "The document editor returned no preview token.")
  const page = new URL(match.destination)
  page.searchParams.set(parameter, "")
  const script = "document.forms[0].submit()"
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening the preview</title></head><body><form method="post" action="${html(page.href)}"><input type="hidden" name="${html(parameter)}" value="${html(JSON.stringify({ token }))}"><noscript><button>Open the preview</button></noscript></form><script>${script}</script></body></html>`
  const out = new Headers({ ...sitePageHeaders, "content-security-policy": `default-src 'none'; script-src 'sha256-${await sha256Base64(script)}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` })
  for (const cookie of headers.getSetCookie()) out.append("set-cookie", cookie)
  return new Response(body, { headers: out })
}

/**
 * Run the action of a checked `impersonate` or `preview` token of `/_vitehub/site`. The Console signs such a token for a
 * member after the app allowed the signed operation of the kind, as that member. The app keeps no state for it: the
 * token works for 60 seconds in the browser that started the visit, and only for its kind and target. `headers` carry
 * the cookies of every answer.
 *
 * - `impersonate`: the browser's app session must belong to the email of the token, and Better Auth must let it
 *   impersonate. A stop ends only an impersonation that the person of the token started in this browser.
 * - `preview`: the `preview` action of the document editor section runs as the person of the token, which checks that
 *   they may read the document, and a page of the app posts its frame token to the page. The Content preview plugin of
 *   the app renders the draft. Its frame form must come from the same origin, so the form leaves from here.
 */
export async function openSiteAction(input: { match: SiteTokenMatch, request: Request, event: ConsoleRequestEvent, app: string, headers: Headers }): Promise<Response> {
  const { match, headers } = input
  try {
    await loadConsoleRuntime()
    if (match.claims.kind === "preview") return await openPreview(match, headers)
    return await impersonate(match, input.request, input.event, `${input.app}/`, headers)
  }
  catch (error) {
    return siteFailurePage(error, headers)
  }
}
