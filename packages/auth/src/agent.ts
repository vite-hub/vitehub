import { getAuth, getAuthForRequest } from "./server.ts"
import {
  invalidAuthenticationErrorOptions,
  throwAuthenticationProviderError,
} from "./errors.ts"
import { getAuthenticationSession } from "./session.ts"

import { ViteHubError } from "@vite-hub/runtime"

import type {
  AgentActor,
  AgentInvoker,
  AgentInvokerOptions,
  AgentInvokerResolveContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "@vite-hub/agent"
import type { AuthenticationSessionSnapshot } from "./session.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

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

/**
 * The `auth` primitive that Agent Capabilities receive when Auth is configured. Generated Agent routes and Schedules
 * pass it, so a Capability can act for the Auth user behind an Agent Actor.
 */
export interface AgentAuth {
  /**
   * The Auth user an Actor stands for. `authenticated()` records the user id as `actor.meta.authUserId`, and this reads
   * that user from the Auth database again, so it also works when an approved tool call runs later. Null for an Actor
   * without `authUserId`, or when the user no longer exists.
   */
  user(actor: AgentActor | null | undefined): Promise<AuthenticatedUser | null>
}

export const agentAuth: AgentAuth = {
  async user(actor) {
    const meta: unknown = actor?.meta
    const userId = isRecord(meta) ? readString(meta.authUserId) : undefined
    if (!userId) return null
    let user: unknown
    try {
      user = await (await getAuth().$context).internalAdapter.findUserById(userId)
    }
    catch (cause) {
      throwAuthenticationProviderError(cause, "get-user")
    }
    // SAFETY: Better Auth returns its user record, which has the string id checked here.
    return isRecord(user) && readString(user.id) ? user as AuthenticatedUser : null
  },
}

function authenticationRequired(message = "[vitehub] Authentication required.") {
  if (!message || message.length > 16_384) invalidAuthenticationErrorOptions()
  return new ViteHubError("AUTHENTICATION_REQUIRED", message)
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
      let auth: AuthenticatedSession<TUser, TSession> | null | undefined
      let providerFields: AuthenticationSessionSnapshot | undefined
      if (options.source) {
        auth = await options.source(context)
      }
      else {
        const resolved = await defaultAuthenticatedSource(context)
        auth = resolved?.auth as AuthenticatedSession<TUser, TSession> | null | undefined
        providerFields = resolved ?? undefined
      }

      if (!auth) {
        if (options.required === false) return undefined
        throw authenticationRequired(options.message)
      }

      const authenticatedContext = {
        ...context,
        auth,
        session: (providerFields?.session ?? auth.session) as TSession,
        user: (providerFields?.user ?? auth.user) as TUser,
      } as AuthenticatedContext<TRuntimeConfig, CALL_OPTIONS, TUser, TSession>
      if (options.map) {
        const invoker = await options.map(authenticatedContext)
        if (!invoker) throw authErrorDiagnostics.AUTH_R0001({ message: "[vitehub] authenticated({ map }) must return an Agent Invoker." })
        return invoker
      }

      return createDefaultInvoker(options, authenticatedContext, providerFields)
    },
  }
}

async function defaultAuthenticatedSource(
  context: AgentInvokerResolveContext,
): Promise<AuthenticationSessionSnapshot | null | undefined> {
  if (!context.request) return undefined

  const auth = getAuthForRequest(context.request)
  return await getAuthenticationSession(auth, {
    headers: context.request.headers,
    query: {
      disableCookieCache: true,
      disableRefresh: true,
    },
  })
}

function readProviderField<T>(read: () => T): T {
  try {
    return read()
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-session")
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
  providerFields?: AuthenticationSessionSnapshot,
): Promise<AgentInvoker> {
  const userId = await resolveAuthenticatedValue(options.id, context) ?? providerFields?.userId ?? readString(context.user.id)
  if (!userId) throw authenticationRequired("[vitehub] Authenticated user is missing an id.")

  const kind = await resolveAuthenticatedValue(options.kind, context) ?? "authUser"
  const label = await resolveAuthenticatedValue(options.label, context)
    ?? (providerFields && readProviderField(() => defaultLabel(providerFields.user, providerFields.userId)))
    ?? defaultLabel(context.user)
  const sessionId = providerFields
    ? readProviderField(() => readString(providerFields.session.id))
    : readString(context.session.id)
  const meta = normalizeMeta(await resolveAuthenticatedValue(options.meta, context))

  return {
    id: userId,
    kind,
    label,
    meta: {
      ...meta,
      authUserId: providerFields?.userId ?? readString(context.user.id) ?? userId,
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

function defaultLabel(user: AuthenticatedUser, fallbackId = user.id): string {
  return readString(user.email) ?? readString(user.name) ?? fallbackId
}

function normalizeMeta(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {}
  if (!isRecord(value)) {
    throw authErrorDiagnostics.AUTH_R0002({ message: "[vitehub] authenticated({ meta }) must resolve to an object." })
  }
  return value
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
