import { isRequestLike, resolveBaseURL } from "better-auth"
import { getCookies } from "better-auth/cookies"
import { readSetCookies } from "./set-cookie.ts"

import type { Auth } from "better-auth"

/**
 * Name of the cookie that tells browser code a session exists. It holds `1`, never a secret, and it is not HttpOnly,
 * so a page script can skip a session request for a visitor who never signed in. It does not prove a session:
 * the server still decides.
 */
export const authSessionMarkerCookie = "vitehub_session"

const markerAttributes = ["domain", "expires", "max-age", "path", "samesite", "partitioned"]

type ApiInput = { headers?: ConstructorParameters<typeof Headers>[0], request?: Request, returnHeaders?: boolean }

function requestSource(input?: Request | ApiInput): Request | Headers | undefined {
  if (isRequestLike(input)) return input
  if (isRequestLike(input?.request)) return input.request
  const headers = new Headers(input?.headers)
  return headers.has("host") || headers.has("x-forwarded-host") ? headers : undefined
}

function readSetCookie(cookie: string): { attributes: string[], cleared: boolean, name: string } {
  const [pair = "", ...rest] = cookie.split(";").map(part => part.trim())
  const separator = pair.indexOf("=")
  const name = separator < 0 ? pair : pair.slice(0, separator)
  const value = separator < 0 ? "" : pair.slice(separator + 1)
  const attributes = rest.filter((part) => {
    const key = part.split("=", 1)[0]!.toLowerCase()
    return key === "secure" || markerAttributes.includes(key)
  })
  const maxAge = rest.find(part => part.toLowerCase().startsWith("max-age="))?.slice(8)
  const expires = rest.find(part => part.toLowerCase().startsWith("expires="))?.slice(8)
  const expired = (maxAge !== undefined && Number(maxAge) <= 0) || (maxAge === undefined && expires !== undefined && Date.parse(expires) <= Date.now())
  return { attributes, cleared: !value || expired, name }
}

/**
 * Sets `vitehub_session` next to the session cookie with the same lifetime, path, domain, and SameSite, and clears it
 * when Better Auth clears the session cookie, such as on sign-out.
 */
export function withSessionMarker(auth: Auth): Auth {
  async function markHeaders(original: Headers, input?: Request | ApiInput): Promise<Headers | undefined> {
    const setCookies = readSetCookies(original)
    if (setCookies.length === 0) return
    const context = await auth.$context
    const options = context.options
    let sessionCookie = context.authCookies.sessionToken.name
    if (typeof options.baseURL === "object" && options.advanced?.crossSubDomainCookies?.enabled) {
      // Better Auth rehydrates cookies for each host in this configuration, including the Secure prefix.
      const baseURL = resolveBaseURL(options.baseURL, options.basePath || "/api/auth", requestSource(input), undefined, options.advanced.trustedProxyHeaders ?? false)
      sessionCookie = getCookies({ ...options, baseURL }).sessionToken.name
    }
    const session = setCookies.map(readSetCookie).findLast(cookie => cookie.name === sessionCookie)
    if (!session) return
    const marker = [
      `${authSessionMarkerCookie}=${session.cleared ? "" : "1"}`,
      ...session.attributes,
      ...(session.cleared ? ["Max-Age=0"] : []),
    ].join("; ")
    const headers = new Headers(original)
    headers.delete("set-cookie")
    for (const cookie of setCookies) if (!cookie.startsWith(`${authSessionMarkerCookie}=`)) headers.append("set-cookie", cookie)
    headers.append("set-cookie", marker)
    return headers
  }

  async function markResponse(response: Response, input?: Request | ApiInput): Promise<Response> {
    const headers = await markHeaders(response.headers, input)
    return headers ? new Response(response.body, { headers, status: response.status, statusText: response.statusText }) : response
  }

  const handler = auth.handler
  // Better Auth stops its response hooks at the first returned response. Process the final result instead.
  const markedHandler: Auth["handler"] = async request => markResponse(await handler(request), request)

  // Better Auth exposes its API as an own data property. Do not invoke provider accessors during setup.
  const originalApi: Auth["api"] | undefined = Object.getOwnPropertyDescriptor(auth, "api")?.value
  if (originalApi) {
    const api = Object.fromEntries(Object.entries(originalApi).map(([name, endpoint]) => [name, Object.assign(async (input?: ApiInput) => {
      const result: unknown = await Reflect.apply(endpoint, originalApi, [input])
      if (result instanceof Response) return markResponse(result, input)
      if (input?.returnHeaders && result && typeof result === "object" && "headers" in result && result.headers instanceof Headers) {
        const headers = await markHeaders(result.headers, input)
        return headers ? { ...result, headers } : result
      }
      return result
    }, endpoint)]))
    // SAFETY: every endpoint retains its arguments, result shape and metadata; only returned cookies change.
    auth.api = api as Auth["api"]
  }
  return Object.assign(auth, { handler: markedHandler, fetch: markedHandler })
}
