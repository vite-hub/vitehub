import { AsyncLocalStorage } from "node:async_hooks"
import { createLogger } from "better-auth"
import { createAuthMiddleware, getOAuthState, isAPIError } from "better-auth/api"
import { requestLog } from "@vite-hub/internal/runtime/request-log"

import type { BetterAuthOptions, BetterAuthPlugin, GenericEndpointContext } from "better-auth"
import type { RequestLog } from "@vite-hub/internal/runtime/request-log"
import type { ViteHubContext } from "@vite-hub/runtime"

/** The `auth` field of a request's wide event, when the app registers evlog. */
export interface AuthRequestOutcome {
  /** The Better Auth endpoint, such as `/sign-in/email` or `/callback/:id`. Not set when no endpoint ran. */
  path?: string
  /** The OAuth provider of a callback or a social sign-in, such as `github`. */
  provider?: string
  /** `success` for a completed sign-in or sign-up, `failure` for a Better Auth error, `refused` for an Auth guard. */
  outcome: "success" | "failure" | "refused"
  status?: number
  /** Better Auth's error code, the `error` of an OAuth error body or callback redirect, or the code of an Auth guard refusal. */
  code?: string
  userId?: string
}

const authHandlerEvent = new AsyncLocalStorage<ViteHubContext>()

const recorded = new WeakSet<object>()

/** Run a Better Auth handler with the request event that endpoints, hooks, and the logger get. */
export function runWithAuthEvent<T>(event: ViteHubContext, run: () => T): T {
  return authHandlerEvent.run(event, run)
}

/** The request event of the running `handleAuthRequest()`. */
export function currentAuthEvent(): ViteHubContext | undefined {
  return authHandlerEvent.getStore()
}

function requestOf(ctx: GenericEndpointContext | null | undefined): object | undefined {
  return currentAuthEvent() ?? ctx?.request
}

/** The evlog request logger of the running Auth request, or of the endpoint's Request. */
export function authRequestLog(ctx?: GenericEndpointContext | null): RequestLog | undefined {
  return requestLog(requestOf(ctx))
}

/** Sets the `auth` field of a request's wide event. Without evlog, it does nothing. */
export function setAuthOutcome(request: object | undefined, outcome: AuthRequestOutcome): void {
  const log = requestLog(request)
  if (!log || !request) return
  recorded.add(request)
  log.set({ auth: outcome })
}

/**
 * Sets `auth` from a Better Auth response when no endpoint set it, such as a refusal of Better Auth's rate limit or
 * origin check. The code comes from the JSON error body: Better Auth's `code`, else an OAuth `error` such as `invalid_grant`.
 */
export async function setAuthResponseOutcome(request: object, response: Response): Promise<void> {
  if (response.status < 400 || recorded.has(request) || !requestLog(request)) return
  let code: string | undefined
  if (response.headers.get("content-type")?.includes("json")) {
    const body: unknown = await response.clone().json().catch(() => undefined)
    code = bodyCode(body)
  }
  setAuthOutcome(request, { outcome: "failure", status: response.status, ...(code ? { code } : {}) })
}

function errorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]{1,100}$/.test(value) ? value : undefined
}

function bodyCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined
  return errorCode(Reflect.get(body, "code")) ?? errorCode(Reflect.get(body, "error"))
}

const signInPath = /^\/(?:sign-in|sign-up|callback|oauth2\/callback|magic-link\/verify|passkey\/verify-authentication|siwe\/verify|two-factor\/verify-|email-otp\/verify-email)/

function provider(ctx: GenericEndpointContext): string | undefined {
  const path = ctx.path ?? ""
  const value: unknown = path.startsWith("/callback/") || path.startsWith("/oauth2/callback/")
    ? ctx.params?.id ?? ctx.params?.providerId
    : ctx.body !== null && typeof ctx.body === "object" ? Reflect.get(ctx.body, "provider") : undefined
  return typeof value === "string" && ctx.context.socialProviders.some(entry => entry.id === value) ? value : undefined
}

async function redirectError(ctx: GenericEndpointContext, headers: ConstructorParameters<typeof Headers>[0]): Promise<string | undefined> {
  if (ctx.path !== "/callback/:id" && ctx.path !== "/oauth2/callback/:providerId") return undefined
  if (ctx.path === "/callback/:id" && ctx.method === "POST") return undefined
  const location = headers ? new Headers(headers).get("location") : null
  if (!location) return undefined
  const { baseURL, options } = ctx.context
  const state = await getOAuthState()
  try {
    const target = new URL(location, baseURL)
    if (state && [state.callbackURL, state.newUserURL].some(url => url && new URL(url, baseURL).href === target.href)) return undefined
    const errorPage = new URL(state?.errorURL || options.onAPIError?.errorURL || `${baseURL}/error`, baseURL)
    const prefix = errorPage.search.endsWith("&") || !errorPage.search ? errorPage.search || "?" : `${errorPage.search}&`
    if (target.origin !== errorPage.origin || target.pathname !== errorPage.pathname || !target.search.startsWith(`${prefix}error=`)) return undefined
    return errorCode(new URLSearchParams(target.search.slice(prefix.length)).get("error"))
  }
  catch {
    return undefined
  }
}

async function endpointOutcome(ctx: GenericEndpointContext, createdUserId: string | undefined): Promise<AuthRequestOutcome | undefined> {
  const path = ctx.path ?? ""
  const oauthProvider = provider(ctx)
  const fields = { path, ...(oauthProvider ? { provider: oauthProvider } : {}) }
  const returned: unknown = Reflect.get(ctx.context, "returned")
  const redirect = isAPIError(returned) && returned.status === "FOUND"
  if (isAPIError(returned) && !redirect) {
    const code = bodyCode(returned.body)
    return { ...fields, outcome: "failure", status: returned.statusCode, ...(code ? { code } : {}) }
  }
  const session = ctx.context.newSession
  if (session && signInPath.test(path)) return { ...fields, outcome: "success", userId: session.user.id }
  const oauthError = redirect ? await redirectError(ctx, returned.headers) : undefined
  if (oauthError) return { ...fields, outcome: "failure", status: 302, code: oauthError }
  if (createdUserId && !redirect) return { ...fields, outcome: "success", userId: createdUserId }
  return undefined
}

/** Sets the outcome of each Better Auth endpoint on the request's wide event. */
export function createRequestLogPlugin(): BetterAuthPlugin {
  const signUps = new WeakMap<object, string>()
  return {
    id: "vitehub-request-log",
    init: () => ({ options: { databaseHooks: { user: { create: { async after(user, ctx) {
      const request = requestOf(ctx)
      if (ctx?.path === "/sign-up/email" && request && requestLog(request)) signUps.set(request, user.id)
    } } } } } }),
    hooks: {
      after: [{
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          const request = requestOf(ctx)
          if (!requestLog(request)) return
          const outcome = await endpointOutcome(ctx, request && signUps.get(request))
          if (outcome) setAuthOutcome(request, outcome)
        }),
      }],
    },
  }
}

function scrub(text: string): string {
  const validation = /^(Invalid (?:origin|callbackURL|redirectURL|errorCallbackURL|newUserCallbackURL|redirect URL)):/i.exec(text)
  return validation?.[1] ?? text.replace(/\bhttps?:\/\/[^\s"'`<>]+/gi, "[url]").replace(/[?#][^\s"'`<>]*/g, "").replace(/[^\s"'`<>@]+(?:@|%40)[^\s"'`<>@]+\.[a-z]{2,}/gi, "[email]").slice(0, 500)
}

type BetterAuthLogger = NonNullable<BetterAuthOptions["logger"]>

/**
 * Better Auth's `logger` that also writes warnings and errors to the request's wide event. The app's own `log`, or
 * Better Auth's console output, still gets every message. Only the message goes on the event: the other arguments can
 * hold provider responses.
 */
export function withRequestLogger(logger: BetterAuthLogger | undefined): BetterAuthLogger {
  let fallback: ReturnType<typeof createLogger> | undefined
  return {
    ...logger,
    log(level, message, ...args) {
      const log = level === "warn" || level === "error" ? authRequestLog() : undefined
      if (log) {
        const text = `[Better Auth] ${scrub(message)}`
        if (level === "warn") log.warn(text)
        else log.error(text)
      }
      if (logger?.log) logger.log(level, message, ...args)
      else (fallback ??= createLogger({ ...logger, log: undefined }))[level](message, ...args)
    },
  }
}
