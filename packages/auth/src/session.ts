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

export async function getAuthenticationSession(
  auth: unknown,
  input: BetterAuthGetSessionInput,
): Promise<ResolvedAuthenticationSession | null | undefined> {
  try {
    const api = readRecordProperty(auth, "api")
    const getSession = api && readProperty(api, "getSession")
    if (typeof getSession !== "function") {
      throw new TypeError("Better Auth did not expose api.getSession().")
    }

    const value = await Reflect.apply(getSession as BetterAuthGetSession, api, [input])
    if (value == null) return value
    if (!isResolvedAuthenticationSession(value)) {
      throw new TypeError("Better Auth returned an invalid session response.")
    }
    return value
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

function readProperty(value: Record<string, unknown>, property: string): unknown {
  return value[property]
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isResolvedAuthenticationSession(value: unknown): value is ResolvedAuthenticationSession {
  return isRecord(value)
    && isRecord(value.session)
    && isRecord(value.user)
    && Boolean(readString(value.user.id))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
