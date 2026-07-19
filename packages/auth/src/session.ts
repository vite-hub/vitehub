import { throwAuthenticationProviderError } from "./errors.ts"

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

export async function getAuthenticationSession(
  auth: unknown,
  input: BetterAuthGetSessionInput,
): Promise<AuthenticationSessionSnapshot | null | undefined> {
  const [api, getSession] = await readProvider(() => {
    const api = readRecordProperty(auth, "api")
    return [api, api && readProperty(api, "getSession")] as const
  })
  if (typeof getSession !== "function") {
    throw new TypeError("Better Auth did not expose api.getSession().")
  }

  const value = await readProvider(() => Reflect.apply(getSession, api, [input]))
  if (value == null) return value
  const session = await readProvider(() => resolveAuthenticationSession(value))
  if (!session) {
    throw new TypeError("Better Auth returned an invalid session response.")
  }
  return session
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

function readProperty(value: Record<string, unknown>, property: string): unknown {
  return value[property]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
