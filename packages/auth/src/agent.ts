import { getAuthForRequest } from "./server.ts"
import { AuthenticationProviderError } from "./errors.ts"
import { getAuthenticationSession } from "./session.ts"

import { ViteHubError } from "@vite-hub/runtime"

import type {
  AgentInvoker,
  AgentInvokerOptions,
  AgentInvokerResolveContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "@vite-hub/agent"
import type {
  AuthenticationProviderErrorOptions,
  AuthenticationProviderOperation,
} from "./errors.ts"

export { AuthenticationProviderError }
export type {
  AuthenticationProviderErrorOptions,
  AuthenticationProviderOperation,
}

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
    })
    this.name = "AuthenticationRequiredError"
    Object.defineProperty(this, "statusCode", {
      enumerable: true,
      value: 401,
    })
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

  const auth = getAuthForRequest(context.request)
  return await getAuthenticationSession(auth, {
    headers: context.request.headers,
    query: {
      disableCookieCache: true,
      disableRefresh: true,
    },
  }) as AuthenticatedSession | null | undefined
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
