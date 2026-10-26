import type { BetterAuthPlugin } from "better-auth"

/**
 * Name of the cookie that tells browser code a session exists. It holds `1`, never a secret, and it is not HttpOnly,
 * so a page script can skip a session request for a visitor who never signed in. It does not prove a session:
 * the server still decides.
 */
export const authSessionMarkerCookie = "vitehub_session"

const markerAttributes = ["domain", "expires", "max-age", "path", "samesite"]

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
export function createSessionMarkerPlugin(): BetterAuthPlugin {
  return {
    id: "vitehub-session-marker",
    async onResponse(response, context) {
      const sessionCookie = context.authCookies.sessionToken.name
      const setCookies = response.headers.getSetCookie()
      const session = setCookies.map(readSetCookie).findLast(cookie => cookie.name === sessionCookie)
      if (!session) return
      const marker = [
        `${authSessionMarkerCookie}=${session.cleared ? "" : "1"}`,
        ...session.attributes,
        ...(session.cleared ? ["Max-Age=0"] : []),
      ].join("; ")
      const headers = new Headers(response.headers)
      headers.delete("set-cookie")
      for (const cookie of setCookies) if (!cookie.startsWith(`${authSessionMarkerCookie}=`)) headers.append("set-cookie", cookie)
      headers.append("set-cookie", marker)
      return { response: new Response(response.body, { headers, status: response.status, statusText: response.statusText }) }
    },
  }
}
