import { resolvePublicUrl } from "@vite-hub/runtime"

import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { consoleErrorResult, consoleRequestError } from "./request.ts"

/** The headers of a page that `/_vitehub/site` answers. */
export const sitePageHeaders = {
  "cache-control": "no-store",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
}

/** A value escaped for HTML text and attributes. */
export function html(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

/** The origin of the app for a request: `vitehub({ publicUrl })` when set, else the URL of the request. */
export function appOrigin(request: Request): string {
  const origin = resolvePublicUrl({ request })
  if (!origin) throw consoleRequestError(403, "The request host is not an origin of vitehub({ publicUrl }).", "CONSOLE_ORIGIN_REJECTED")
  return new URL(origin).origin
}

/** A `303` to `location` that keeps the `set-cookie` headers of `headers`. */
export function seeOther(location: string, headers: Headers = new Headers()): Response {
  const out = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer", location })
  for (const cookie of headers.getSetCookie()) out.append("set-cookie", cookie)
  return new Response(null, { headers: out, status: 303 })
}

function problemPage(problem: { code: string, message: string, fix?: string, status: number }, headers = new Headers()): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(problem.message)}</title></head><body><main><h1>${html(problem.message)}</h1>${problem.fix ? `<p>${html(problem.fix)}</p>` : ""}<p><code>${html(problem.code)}</code></p></main></body></html>`
  const out = new Headers({ ...sitePageHeaders, "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" })
  for (const cookie of headers.getSetCookie()) out.append("set-cookie", cookie)
  return new Response(page, { headers: out, status: problem.status })
}

/** The page of a refused visit: the diagnostic code, the why, and the fix. `fix` replaces the general fix of the code. */
export function siteProblemPage(status: number, code: ConsoleDiagnosticCode, message?: string, fix?: string, headers?: Headers): Response {
  return problemPage({ ...consoleDiagnosticBody(code, message), ...(fix ? { fix } : {}), status }, headers)
}

/** A failure as a page. A failure without an HTTP status is a bug: it is logged, and the page shows no detail. */
export function siteFailurePage(error: unknown, headers?: Headers): Response {
  const result = consoleErrorResult(error)
  if (result.status >= 500) globalThis.console.error("[vitehub] Site access failed.", error)
  return problemPage(result.status >= 500 ? { ...consoleDiagnosticBody("CONSOLE_REQUEST_FAILED"), status: result.status } : result, headers)
}
