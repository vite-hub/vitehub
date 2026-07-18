import { throwAuthenticationProviderError } from "./errors.ts"

import type { MaybePromise } from "@vite-hub/agent"

interface BetterAuthGetSessionInput {
  headers: Headers
  query?: {
    disableCookieCache?: boolean
    disableRefresh?: boolean
  }
}

type BetterAuthGetSession = (input: BetterAuthGetSessionInput) => MaybePromise<unknown>

interface ResolvedAuthenticationSession {
  session: Record<string, unknown>
  user: Record<string, unknown> & { id: string }
}

interface AuthenticationSessionSnapshot extends ResolvedAuthenticationSession {
  auth: ResolvedAuthenticationSession
  userId: string
}

export async function getAuthenticationSession(
  auth: unknown,
  input: BetterAuthGetSessionInput,
  inspect?: (session: AuthenticationSessionSnapshot) => void,
): Promise<ResolvedAuthenticationSession | null | undefined> {
  let api: Record<string, unknown> | undefined
  let getSession: unknown
  try {
    api = readRecordProperty(auth, "api")
    getSession = api && readProperty(api, "getSession")
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-session")
  }
  if (typeof getSession !== "function") {
    throw new TypeError("Better Auth did not expose api.getSession().")
  }

  let value: unknown
  try {
    value = await Reflect.apply(getSession as BetterAuthGetSession, api, [input])
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-session")
  }

  if (value == null) return value
  let session: ResolvedAuthenticationSession | undefined
  try {
    const snapshot = resolveAuthenticationSession(value)
    if (snapshot) {
      session = snapshot.auth
      inspect?.(snapshot)
    }
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-session")
  }
  if (!session) {
    throw new TypeError("Better Auth returned an invalid session response.")
  }
  return session
}

function readRecordProperty(value: unknown, property: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return
  const nested = readProperty(value, property)
  return isRecord(nested) ? nested : undefined
}

function readProperty(value: Record<string, unknown>, property: string): unknown {
  return value[property]
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function resolveAuthenticationSession(value: unknown): AuthenticationSessionSnapshot | undefined {
  if (!isRecord(value)) return
  const session = value.session
  const user = value.user
  if (!isRecord(session) || !isRecord(user)) return
  const userId = readString(user.id)
  if (!userId) return
  return {
    auth: value as unknown as ResolvedAuthenticationSession,
    session,
    user: user as ResolvedAuthenticationSession["user"],
    userId,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
