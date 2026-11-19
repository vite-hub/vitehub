import { HTTPError } from "nitro/h3"

import { throwAuthenticationProviderError } from "./errors.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { readSetCookies } from "./set-cookie.ts"
import { isRecord } from "@vite-hub/internal/object"

interface BetterAuthGetSessionInput {
  headers: Headers
  query?: {
    disableCookieCache?: boolean
    disableRefresh?: boolean
  }
}

export interface AuthenticationSessionSnapshot {
  auth: { session: Record<string, unknown>, user: Record<string, unknown> & { id: string } }
  session: Record<string, unknown>
  user: Record<string, unknown> & { id: string }
  userId: string
}

/** The session of a request, and the cookies that Better Auth set while it read it. */
export interface AuthenticationSessionRead {
  session: AuthenticationSessionSnapshot | null
  /**
   * The `Set-Cookie` values of the read: the renewed session cookie after `session.updateAge`, a refreshed cookie
   * cache, or the deletion of an ended session. The response to the request must carry them, else the browser keeps
   * the old cookies and loses the session when they expire.
   */
  setCookies: string[]
  /**
   * Better Auth refused the credentials of the request with a `4xx` status, such as an invalid key of the API Key
   * plugin. A guard answers with it in place of its own `SIGNED_OUT` refusal.
   */
  refusal?: AuthenticationRefusal
}

/** A `4xx` refusal of a Better Auth session read. `headers` has the headers other than `Set-Cookie`. */
export interface AuthenticationRefusal {
  code?: string
  headers: Headers
  message?: string
  status: number
}

// Better Auth keeps the cookies that an endpoint set before it threw an `APIError`, such as the deletion of an ended
// session, on the error under this key of better-call.
const apiErrorHeaders = Symbol.for("better-call:api-error-headers")

export async function getAuthenticationSession(
  auth: unknown,
  input: BetterAuthGetSessionInput,
): Promise<AuthenticationSessionRead> {
  const [api, getSession] = await readProvider(() => {
    const api = readRecordProperty(auth, "api")
    return [api, api && readProperty(api, "getSession")] as const
  })
  if (typeof getSession !== "function") {
    throw authErrorDiagnostics.AUTH_R0011({ message: "Better Auth did not expose api.getSession()." })
  }

  let refusal: AuthenticationRefusal | undefined
  const value = await readProvider(async () => {
    try {
      return await Reflect.apply(getSession, api, [{ ...input, returnHeaders: true }])
    }
    catch (cause) {
      // Better Auth answers 401 when a refresh ends the session, for example from `session.onRefresh`.
      if (isUnauthorizedApiError(cause)) {
        const headers: unknown = Reflect.get(cause, apiErrorHeaders)
        return { headers: headers instanceof Headers ? headers : undefined, response: null }
      }
      // A plugin refuses the credentials of the request, such as an invalid key of the API Key plugin. Keep its status.
      const client = readClientApiError(cause)
      if (!client) throw cause
      refusal = client.refusal
      return { headers: client.headers, response: null }
    }
  })
  const read = await readProvider(() => resolveAuthenticationSessionRead(value))
  if (!read) {
    throw authErrorDiagnostics.AUTH_R0012({ message: "Better Auth returned an invalid session response." })
  }
  return refusal ? { ...read, refusal } : read
}

/** The H3 error format of a refusal, as the guards answer their own refusals. */
export function authenticationRefusalResponse(refusal: AuthenticationRefusal): Response {
  return Response.json(
    { status: refusal.status, message: refusal.message, data: refusal.code ? { code: refusal.code } : undefined },
    { headers: refusal.headers, status: refusal.status },
  )
}

/** The `HTTPError` of a refusal, for a caller that throws. */
export function authenticationRefusalError(refusal: AuthenticationRefusal): HTTPError {
  return new HTTPError({ data: refusal.code ? { code: refusal.code } : undefined, headers: refusal.headers, message: refusal.message, status: refusal.status })
}

async function readProvider<T>(read: () => T | PromiseLike<T>): Promise<T> {
  try {
    return await read()
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-session")
  }
}

function readRecordProperty(value: unknown, property: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return
  const nested = readProperty(value, property)
  return isRecord(nested) ? nested : undefined
}

/** Reads the `{ headers, response }` result of `getSession({ returnHeaders: true })`. */
function resolveAuthenticationSessionRead(value: unknown): AuthenticationSessionRead | undefined {
  if (!isRecord(value) || !("response" in value)) return
  const { headers, response } = value
  if (headers !== undefined && headers !== null && !(headers instanceof Headers)) return
  const setCookies = headers ? readSetCookies(headers) : []
  if (response === null) return { session: null, setCookies }
  const session = resolveAuthenticationSession(response)
  return session && { session, setCookies }
}

function resolveAuthenticationSession(value: unknown): AuthenticationSessionSnapshot | undefined {
  if (!isRecord(value)) return
  const session = value.session
  const user = value.user
  if (!isRecord(session) || !isRecord(user)) return
  const userId = user.id
  if (typeof userId !== "string" || userId.length === 0) return
  return {
    auth: value as AuthenticationSessionSnapshot["auth"],
    session,
    user: user as AuthenticationSessionSnapshot["user"],
    userId,
  }
}

function isUnauthorizedApiError(error: unknown): error is object {
  if (typeof error !== "object" || error === null) return false
  try {
    if (Reflect.get(error, "name") !== "APIError" || Reflect.get(error, "statusCode") !== 401) return false
    const body = Reflect.get(error, "body")
    return typeof body === "object" && body !== null && Reflect.get(body, "code") === "FAILED_TO_GET_SESSION"
  }
  catch {
    return false
  }
}

/**
 * The refusal of a Better Auth `APIError` with a 4xx status, and all its headers. A `before` hook can pass headers to
 * the error, and better-call keeps the headers that the endpoint set before under its own key. Both reach the client.
 */
function readClientApiError(error: unknown): { headers: Headers, refusal: AuthenticationRefusal } | undefined {
  if (typeof error !== "object" || error === null) return
  try {
    if (Reflect.get(error, "name") !== "APIError") return
    const status: unknown = Reflect.get(error, "statusCode")
    if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 499) return
    const body: unknown = Reflect.get(error, "body")
    const headers = new Headers()
    for (const source of [Reflect.get(error, apiErrorHeaders), Reflect.get(error, "headers")]) {
      if (!(source instanceof Headers) && !isRecord(source)) continue
      const incoming = new Headers(source instanceof Headers ? source : Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      for (const cookie of incoming.getSetCookie()) {
        if (!headers.getSetCookie().includes(cookie)) headers.append("set-cookie", cookie)
      }
      for (const [name, value] of incoming) {
        if (name !== "set-cookie" && !headers.has(name)) headers.set(name, value)
      }
    }
    const refusalHeaders = new Headers(headers)
    refusalHeaders.delete("set-cookie")
    return {
      headers,
      refusal: {
        code: isRecord(body) && typeof body.code === "string" ? body.code : undefined,
        headers: refusalHeaders,
        message: isRecord(body) && typeof body.message === "string" ? body.message : undefined,
        status,
      },
    }
  }
  catch {
    return undefined
  }
}

function readProperty(value: Record<string, unknown>, property: string): unknown {
  return value[property]
}

