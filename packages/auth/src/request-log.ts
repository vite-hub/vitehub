import { AsyncLocalStorage } from "node:async_hooks"
import { createLogger } from "better-auth"
import { createAuthMiddleware, isAPIError } from "better-auth/api"
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
  /** Better Auth's error code, the `error` of an OAuth callback redirect, or the code of an Auth guard refusal. */
  code?: string
  userId?: string
}

// Better Auth gets only the Request. `handleAuthRequest()` runs it in this store, so endpoints get the event of the route.
const authHandlerEvent = new AsyncLocalStorage<ViteHubContext>()

// Requests that already have an `auth` outcome, so a later, less exact source does not replace it.
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
 * origin check. The code comes from Better Auth's JSON error body.
 */
export async function setAuthResponseOutcome(request: object, response: Response): Promise<void> {
  if (response.status < 400 || recorded.has(request) || !requestLog(request)) return
  let code: string | undefined
  if (response.headers.get("content-type")?.includes("json")) {
    const body: unknown = await response.clone().json().catch(() => undefined)
    code = errorCode(body !== null && typeof body === "object" ? Reflect.get(body, "code") : undefined)
  }
  setAuthOutcome(request, { outcome: "failure", status: response.status, ...(code ? { code } : {}) })
}

function errorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]{1,100}$/.test(value) ? value : undefined
}

const signInPath = /^\/(?:sign-in|sign-up|callback|oauth2\/callback|magic-link\/verify|passkey\/verify-authentication|siwe\/verify|two-factor\/verify-|email-otp\/verify-email)/

/** The OAuth provider of a callback path or a social sign-in body, when the app configures it. */
function provider(ctx: GenericEndpointContext): string | undefined {
  const path = ctx.path ?? ""
  const value: unknown = path.startsWith("/callback/") || path.startsWith("/oauth2/callback/")
    ? ctx.params?.id ?? ctx.params?.providerId
    : ctx.body !== null && typeof ctx.body === "object" ? Reflect.get(ctx.body, "provider") : undefined
  return typeof value === "string" && ctx.context.socialProviders.some(entry => entry.id === value) ? value : undefined
}

/** The `error` of a redirect to Better Auth's error page, such as `state_mismatch` after a failed OAuth callback. */
function redirectError(headers: ConstructorParameters<typeof Headers>[0], baseURL: string): string | undefined {
  const location = headers ? new Headers(headers).get("location") : null
  if (!location) return undefined
  try {
    return errorCode(new URL(location, baseURL || "http://localhost").searchParams.get("error"))
  }
  catch {
    return undefined
  }
}

/** The outcome of one endpoint: an error, a redirect to the error page, or a new session. Else `undefined`. */
function endpointOutcome(ctx: GenericEndpointContext): AuthRequestOutcome | undefined {
  const path = ctx.path ?? ""
  const oauthProvider = provider(ctx)
  const fields = { path, ...(oauthProvider ? { provider: oauthProvider } : {}) }
  // Better Auth passes the endpoint result to after-hooks outside the public middleware input type.
  const returned: unknown = Reflect.get(ctx.context, "returned")
  // `ctx.redirect()` throws Better Call's APIError, not Better Auth's, so `instanceof` misses it.
  const redirect = isAPIError(returned) && returned.status === "FOUND"
  if (isAPIError(returned) && !redirect) {
    const code = errorCode(returned.body?.code)
    return { ...fields, outcome: "failure", status: returned.statusCode, ...(code ? { code } : {}) }
  }
  const oauthError = redirect ? redirectError(returned.headers, ctx.context.baseURL) : undefined
  if (oauthError) return { ...fields, outcome: "failure", status: 302, code: oauthError }
  const session = ctx.context.newSession
  return session && signInPath.test(path) ? { ...fields, outcome: "success", userId: session.user.id } : undefined
}

/** Sets the outcome of each Better Auth endpoint on the request's wide event. */
export function createRequestLogPlugin(): BetterAuthPlugin {
  return {
    id: "vitehub-request-log",
    hooks: {
      after: [{
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          const request = requestOf(ctx)
          if (!requestLog(request)) return
          const outcome = endpointOutcome(ctx)
          if (outcome) setAuthOutcome(request, outcome)
        }),
      }],
    },
  }
}

/** Removes the query and hash of URLs, and email addresses, from a log message. */
function scrub(text: string): string {
  return text.replace(/[?#][^\s"'`<>]*/g, "").replace(/[^\s"'`<>@]+@[^\s"'`<>@]+\.[a-z]{2,}/gi, "[email]").slice(0, 500)
}

/** An error with `text` as its message and the stack frames of `cause`, without the message or fields of `cause`. */
function errorWithStack(cause: Error, text: string): Error {
  const error = Object.assign(new Error(text), { name: cause.name })
  const frames = (cause.stack ?? "").split("\n").filter(line => /^\s+at /.test(line))
  error.stack = [`${cause.name}: ${text}`, ...frames].join("\n")
  return error
}

type BetterAuthLogger = NonNullable<BetterAuthOptions["logger"]>

/**
 * Better Auth's `logger` that also writes warnings and errors to the request's wide event. The app's own `log`, or
 * Better Auth's console output, still gets every message. Only the message goes on the event: the other arguments can
 * hold provider responses.
 */
export function withRequestLogger(logger: BetterAuthLogger | undefined): BetterAuthLogger {
  // Better Auth's console logger, made on the first message, when the app has no `log` of its own.
  let fallback: ReturnType<typeof createLogger> | undefined
  return {
    ...logger,
    log(level, message, ...args) {
      const log = level === "warn" || level === "error" ? authRequestLog() : undefined
      if (log) {
        const text = `[Better Auth] ${scrub(message)}`
        const cause: unknown = args[0]
        if (level === "warn") log.warn(text)
        else if (cause instanceof Error) log.error(errorWithStack(cause, text))
        else log.error(text)
      }
      if (logger?.log) logger.log(level, message, ...args)
      else (fallback ??= createLogger({ ...logger, log: undefined }))[level](message, ...args)
    },
  }
}
