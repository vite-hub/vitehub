import { getAuthForRequest } from "./server.ts"

import { ViteHubError } from "@vite-hub/runtime"

import type {
  AgentInvoker,
  AgentInvokerOptions,
  AgentInvokerResolveContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "@vite-hub/agent"
import type { ViteHubErrorDetails } from "@vite-hub/runtime"

export interface AuthenticatedUser {
  email?: string | null
  id: string
  image?: string | null
  name?: string | null
  [key: string]: unknown
}

export interface AuthenticatedSessionData {
  id?: string
  token?: string
  userId?: string
  [key: string]: unknown
}

export interface AuthenticatedSession<
  TUser extends AuthenticatedUser = AuthenticatedUser,
  TSession extends AuthenticatedSessionData = AuthenticatedSessionData,
> {
  session: TSession
  user: TUser
}

export interface AuthenticatedContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TUser extends AuthenticatedUser = AuthenticatedUser,
  TSession extends AuthenticatedSessionData = AuthenticatedSessionData,
> extends AgentInvokerResolveContext<TRuntimeConfig, CALL_OPTIONS> {
  auth: AuthenticatedSession<TUser, TSession>
  session: TSession
  user: TUser
}

export type AuthenticatedSource<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TUser extends AuthenticatedUser = AuthenticatedUser,
  TSession extends AuthenticatedSessionData = AuthenticatedSessionData,
> = (context: AgentInvokerResolveContext<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<
  AuthenticatedSession<TUser, TSession> | null | undefined
>

export type AuthenticatedValue<
  TValue,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TUser extends AuthenticatedUser = AuthenticatedUser,
  TSession extends AuthenticatedSessionData = AuthenticatedSessionData,
> = TValue | ((context: AuthenticatedContext<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>) => MaybePromise<TValue>)

export type AuthenticatedMapper<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TUser extends AuthenticatedUser = AuthenticatedUser,
  TSession extends AuthenticatedSessionData = AuthenticatedSessionData,
> = (context: AuthenticatedContext<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>) => MaybePromise<AgentInvoker>

export interface AuthenticatedOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TUser extends AuthenticatedUser = AuthenticatedUser,
  TSession extends AuthenticatedSessionData = AuthenticatedSessionData,
> {
  id?: AuthenticatedValue<string | null | undefined, TRuntimeConfig, CALL_OPTIONS, TUser, TSession>
  kind?: AuthenticatedValue<AgentInvoker["kind"] | null | undefined, TRuntimeConfig, CALL_OPTIONS, TUser, TSession>
  label?: AuthenticatedValue<string | null | undefined, TRuntimeConfig, CALL_OPTIONS, TUser, TSession>
  map?: AuthenticatedMapper<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>
  message?: string
  meta?: AuthenticatedValue<Record<string, unknown> | null | undefined, TRuntimeConfig, CALL_OPTIONS, TUser, TSession>
  required?: boolean
  source?: AuthenticatedSource<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>
}

export interface AuthenticationRequiredErrorOptions extends ErrorOptions {
  details?: ViteHubErrorDetails
  message?: string
}

export class AuthenticationRequiredError extends ViteHubError<"AUTHENTICATION_REQUIRED"> {
  declare readonly statusCode: 401

  constructor(options?: AuthenticationRequiredErrorOptions)
  constructor(message?: string)
  constructor(messageOrOptions: AuthenticationRequiredErrorOptions | string = {}) {
    const options = typeof messageOrOptions === "string" ? {} : messageOrOptions
    const message = typeof messageOrOptions === "string"
      ? messageOrOptions
      : messageOrOptions.message ?? "[vitehub] Authentication required."

    super("AUTHENTICATION_REQUIRED", message, {
      cause: options.cause,
      details: options.details,
    })
    this.name = "AuthenticationRequiredError"
    Object.defineProperty(this, "statusCode", {
      enumerable: true,
      value: 401,
    })
  }
}

export type AuthenticationProviderOperation = "get-auth-for-request" | "get-session"

export interface AuthenticationProviderErrorOptions extends ErrorOptions {
  operation: AuthenticationProviderOperation
}

export class AuthenticationProviderError extends ViteHubError<
  "AUTH_PROVIDER_OPERATION_FAILED",
  { operation: AuthenticationProviderOperation, provider: "better-auth" }
> {
  constructor(options: AuthenticationProviderErrorOptions) {
    super("AUTH_PROVIDER_OPERATION_FAILED", "[vitehub] Authentication provider operation failed.", {
      cause: options.cause,
      details: {
        operation: options.operation,
        provider: "better-auth",
      },
    })
    this.name = "AuthenticationProviderError"
  }
}

interface BetterAuthGetSessionInput {
  headers: Headers
  query?: {
    disableCookieCache?: boolean
    disableRefresh?: boolean
  }
}

type BetterAuthGetSession = (input: BetterAuthGetSessionInput) => MaybePromise<unknown>

interface BetterAuthSessionApi {
  api?: {
    getSession?: BetterAuthGetSession
  }
}

export function authenticated<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TUser extends AuthenticatedUser = AuthenticatedUser,
  TSession extends AuthenticatedSessionData = AuthenticatedSessionData,
>(
  options: AuthenticatedOptions<TRuntimeConfig, CALL_OPTIONS, TUser, TSession> = {},
): AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS> {
  return {
    async resolve(context) {
      const source = (options.source ?? defaultAuthenticatedSource) as AuthenticatedSource<
        TRuntimeConfig,
        CALL_OPTIONS,
        TUser,
        TSession
      >
      const auth = await source(context)

      if (!auth) {
        if (options.required === false) return undefined
        throw new AuthenticationRequiredError(options.message)
      }

      const authenticatedContext = createAuthenticatedContext<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>(context, auth)
      if (options.map) {
        const invoker = await options.map(authenticatedContext)
        if (!invoker) throw new TypeError("[vitehub] authenticated({ map }) must return an Agent Invoker.")
        return invoker
      }

      return createDefaultInvoker(options, authenticatedContext)
    },
  }
}

async function defaultAuthenticatedSource(
  context: AgentInvokerResolveContext,
): Promise<AuthenticatedSession | null | undefined> {
  if (!context.request) return undefined

  let auth: BetterAuthSessionApi
  try {
    auth = getAuthForRequest(context.request) as BetterAuthSessionApi
  }
  catch (cause) {
    throw new AuthenticationProviderError({ cause, operation: "get-auth-for-request" })
  }

  let session: unknown
  try {
    session = await auth.api?.getSession?.({
      headers: context.request.headers,
      query: {
        disableCookieCache: true,
        disableRefresh: true,
      },
    })
  }
  catch (cause) {
    throw new AuthenticationProviderError({ cause, operation: "get-session" })
  }
  return normalizeAuthenticatedSession(session)
}

function createAuthenticatedContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TUser extends AuthenticatedUser,
  TSession extends AuthenticatedSessionData,
>(
  context: AgentInvokerResolveContext<TRuntimeConfig, CALL_OPTIONS>,
  auth: AuthenticatedSession<TUser, TSession>,
): AuthenticatedContext<TRuntimeConfig, CALL_OPTIONS, TUser, TSession> {
  return {
    ...context,
    auth,
    session: auth.session,
    user: auth.user,
  }
}

async function createDefaultInvoker<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TUser extends AuthenticatedUser,
  TSession extends AuthenticatedSessionData,
>(
  options: AuthenticatedOptions<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>,
  context: AuthenticatedContext<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>,
): Promise<AgentInvoker> {
  const userId = await resolveAuthenticatedValue(options.id, context) ?? readString(context.user.id)
  if (!userId) throw new AuthenticationRequiredError("[vitehub] Authenticated user is missing an id.")

  const kind = await resolveAuthenticatedValue(options.kind, context) ?? "authUser"
  const label = await resolveAuthenticatedValue(options.label, context) ?? defaultLabel(context.user)
  const sessionId = readString(context.session.id)
  const meta = normalizeMeta(await resolveAuthenticatedValue(options.meta, context))

  return {
    id: userId,
    kind,
    label,
    meta: {
      ...meta,
      authUserId: readString(context.user.id) ?? userId,
      ...(sessionId ? { authSessionId: sessionId } : {}),
    },
  }
}

function resolveAuthenticatedValue<
  TValue,
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TUser extends AuthenticatedUser,
  TSession extends AuthenticatedSessionData,
>(
  value: AuthenticatedValue<TValue, TRuntimeConfig, CALL_OPTIONS, TUser, TSession> | undefined,
  context: AuthenticatedContext<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>,
): MaybePromise<TValue | undefined> {
  if (typeof value === "function") {
    return (value as (context: AuthenticatedContext<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>) => MaybePromise<TValue>)(context)
  }
  return value
}

function normalizeAuthenticatedSession(value: unknown): AuthenticatedSession | null | undefined {
  if (!isRecord(value)) return undefined
  if (!isRecord(value.user) || !isRecord(value.session)) return undefined

  const userId = readString(value.user.id)
  if (!userId) return undefined

  return {
    session: value.session as AuthenticatedSessionData,
    user: {
      ...value.user,
      id: userId,
    } as AuthenticatedUser,
  }
}

function defaultLabel(user: AuthenticatedUser): string {
  return readString(user.email) ?? readString(user.name) ?? user.id
}

function normalizeMeta(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {}
  if (!isRecord(value)) {
    throw new TypeError("[vitehub] authenticated({ meta }) must resolve to an object.")
  }
  return value
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
