import type { AccessAuthorizationContext } from "@vite-hub/runtime"
import type { AuthAccessAuthorize, AuthDefinition, AuthDefinitionInput, AuthResolvedDefinitionOptions, AuthRuntimeConfiguration, AuthRuntimeContext, AuthSignInConfiguration } from "@vite-hub/auth"
import { createAuthForRequest, type getAuthForRequest } from "@vite-hub/auth/server"
import { toEventRequest } from "@vite-hub/internal/runtime/h3-v1-request"
import * as v from "valibot"
import { consoleMountBase } from "./runtime/console-route.ts"
import { consoleRequestURL } from "./runtime/server/request.ts"
import { consoleAuthPath, consoleEventPath } from "./auth-path.ts"
import { isConsoleDevelopmentBuild } from "./runtime/server/development.ts"

export const consoleAuthBasePath = "/api/_vitehub/console/auth"

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

export function consoleAuthSignInPage(provider: string, request: Request, mountBaseURL = "/"): Response {
  const buttonLabel = provider.toLowerCase() === "github" ? "Sign in with GitHub" : `Sign in with ${provider}`
  const startPath = consoleAuthPath(mountBaseURL, "/_vitehub?auth_start=1")
  const search = new URL(request.url).searchParams
  const message = search.has("denied")
    ? "Your previous account cannot access this Console. Choose a different account with your sign-in provider before signing in again."
    : search.has("auth_error")
      ? "Sign-in failed. Try again."
      : search.has("signed_out")
        ? "You have signed out."
        : "Sign in to access the ViteHub Console."
  return consoleSignInDocument(message, `<a href="${escapeHTML(startPath)}"${isConsoleDevelopmentBuild() ? ' target="_top"' : ""}>${escapeHTML(buttonLabel)}</a>`)
}

function consoleSignInDocument(message: string, actions: string, status = 200): Response {
  const development = isConsoleDevelopmentBuild()
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>Sign in · ViteHub Console</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; background: light-dark(#fafafa, #0a0a0a); color: light-dark(#171717, #f5f5f5); }
      main { width: min(24rem, calc(100% - 3rem)); }
      h1 { margin: 0 0 .5rem; font-size: 1.5rem; font-weight: 600; }
      p { margin: 0 0 1.5rem; color: light-dark(#525252, #a3a3a3); line-height: 1.5; }
      form { margin: .75rem 0; }
      a, button { font: inherit; border: 0; cursor: pointer; display: inline-flex; min-height: 2.5rem; align-items: center; padding: 0 1rem; border-radius: .5rem; background: light-dark(#171717, #f5f5f5); color: light-dark(#fff, #171717); font-weight: 500; text-decoration: none; }
      a:focus-visible, button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Sign in</h1>
      <p role="status">${escapeHTML(message)}</p>
      ${actions}
    </main>
  </body>
</html>`
  return new Response(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self' https:; frame-ancestors ${development ? "'self'" : "'none'"}`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": development ? "SAMEORIGIN" : "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
    status,
  })
}

export function consoleAuthPageResponse(request: Request, response: Response | undefined, mountBaseURL = "/", authBasePath: string = consoleAuthBasePath): Response | undefined {
  if (response?.status === 401 && request.method === "GET" && request.headers.get("accept")?.includes("text/html")) {
    const signIn = new URL(consoleAuthPath(mountBaseURL, "/_vitehub/sign-in"), request.url)
    if (new URL(request.url).searchParams.has("auth_error")) signIn.searchParams.set("auth_error", "signin")
    return Response.redirect(signIn, 302)
  }
  if (
    response?.status !== 403
    || request.method !== "GET"
    || !request.headers.get("accept")?.includes("text/html")
    || !response.headers.get("content-type")?.startsWith("text/plain")
  ) return response

  const development = isConsoleDevelopmentBuild()
  const signOutPath = authBasePath === consoleAuthBasePath ? consoleAuthPath(mountBaseURL, `${authBasePath}/sign-out`) : `${authBasePath}/sign-out`
  const signedOutPath = consoleAuthPath(mountBaseURL, "/_vitehub/sign-in?denied=1")
  const signOutLiteral = JSON.stringify(signOutPath).replaceAll("<", "\\u003c")
  const signedOutLiteral = JSON.stringify(signedOutPath).replaceAll("<", "\\u003c")
  const nonce = crypto.randomUUID()
  const script = `
    const button = document.querySelector("button");
    const error = document.querySelector("[role=alert]");
    button.addEventListener("click", async () => {
      button.disabled = true;
      error.hidden = true;
      try {
        const response = await fetch(${signOutLiteral}, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!response.ok) throw new Error("Sign-out failed");
        window.location.assign(${signedOutLiteral});
      } catch {
        error.hidden = false;
        button.disabled = false;
      }
    });
  `
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>Access denied · ViteHub Console</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; background: light-dark(#fafafa, #0a0a0a); color: light-dark(#171717, #f5f5f5); }
      main { width: min(24rem, calc(100% - 3rem)); }
      h1 { margin: 0 0 .5rem; font-size: 1.5rem; font-weight: 600; }
      p { color: light-dark(#525252, #a3a3a3); line-height: 1.5; }
      button { min-height: 2.5rem; padding: 0 1rem; border: 0; border-radius: .5rem; background: light-dark(#171717, #f5f5f5); color: light-dark(#fff, #171717); font: inherit; font-weight: 500; cursor: pointer; }
      button:disabled { opacity: .6; cursor: wait; }
      button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Access denied</h1>
      <p>This account cannot access the ViteHub Console.</p>
      <button type="button">Switch account</button>
      <p role="alert" hidden>Could not sign out. Try again.</p>
    </main>
    <script nonce="${nonce}">${script}</script>
  </body>
</html>`
  return new Response(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${development ? "'self'" : "'none'"}`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": development ? "SAMEORIGIN" : "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
    status: 403,
  })
}

/** Use the app's configured social providers and session without a second Auth Definition or client. */
export function createConsoleAppAuthPages(resolveAuth: typeof getAuthForRequest): {
  signIn: (event: object, denied?: Response) => Promise<Response>
  authBasePath: (event: object) => Promise<string>
} {
  async function requestAuth(event: object) {
    const request = toEventRequest(event)
    const url = consoleRequestURL({ req: request })
    const authRequest = { headers: request.headers, url: url.href }
    let auth = resolveAuth(authRequest, undefined, event)
    let context = await auth.$context
    // A static provider has no origin until its first HTTP request. Resolve it before reading its URLs.
    if (!context.baseURL) {
      auth = resolveAuth(authRequest, { baseURL: url.origin }, event)
      context = await auth.$context
    }
    return { auth, context, request, url }
  }
  return {
    async authBasePath(event) {
      const { context } = await requestAuth(event)
      return new URL(context.baseURL).pathname.replace(/\/$/, "")
    },
    signIn: async (event: object, denied?: Response): Promise<Response> => {
      const { auth, context, request, url } = await requestAuth(event)
      const mount = consoleMountBase(url.pathname)
      const page = `${mount}/_vitehub/sign-in`
      const authURL = new URL(context.baseURL)
      if (denied) {
        const diagnostic = v.safeParse(v.object({ code: v.literal("CONSOLE_ACCESS_DENIED") }), await denied.clone().json().catch(() => undefined))
        const response = diagnostic.success ? new Response("Forbidden.", { status: 403, headers: { "content-type": "text/plain" } }) : denied
        return consoleAuthPageResponse(request, response, mount, authURL.pathname.replace(/\/$/, "")) ?? denied
      }
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
        return new Response(null, { headers: { allow: "GET, HEAD, POST" }, status: 405 })
      }
      const target = consoleReturnPath(url.searchParams.get("redirect"), url, mount)
      const retry = new URL(page, url)
      retry.searchParams.set("redirect", target)
      const actions = context.socialProviders.map((provider) => {
        const start = new URL(retry)
        start.searchParams.set("provider", provider.id)
        const label = provider.id === "github" ? "GitHub" : provider.name
        return `<form method="post" action="${escapeHTML(`${start.pathname}${start.search}`)}"${isConsoleDevelopmentBuild() ? ' target="_top"' : ""}><button type="submit">Sign in with ${escapeHTML(label)}</button></form>`
      }).join("")
      const render = (failed = false) => consoleSignInDocument(
        failed ? "Sign-in failed. Try again." : actions ? "Sign in to access the ViteHub Console." : "No social sign-in provider is configured. Configure a provider in server Auth, or set console.signInPage to your app's sign-in page.",
        actions,
        actions ? 200 : 503,
      )
      if (request.method !== "POST") return render(url.searchParams.has("auth_error"))
      // The Console starts OAuth with the app's own trusted origin. Cross-origin forms must not start a login.
      if (request.headers.get("origin") !== url.origin || !await context.isTrustedOrigin(url.origin)) {
        return new Response("Untrusted sign-in origin.", { status: 403 })
      }
      const provider = url.searchParams.get("provider")
      if (!context.socialProviders.some(candidate => candidate.id === provider)) return render(true)
      retry.searchParams.set("auth_error", "signin")
      try {
        const response = await auth.handler(new Request(`${authURL.href.replace(/\/$/, "")}/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: url.origin },
          body: JSON.stringify({ provider, callbackURL: new URL(target, url).href, errorCallbackURL: retry.href }),
        }))
        if (!response.ok) return render(true)
        const result = v.safeParse(v.object({ url: v.string() }), await response.json())
        if (!result.success) return render(true)
        const destination = new URL(result.output.url)
        if (destination.protocol !== "https:" && destination.protocol !== "http:") return render(true)
        const headers = new Headers(response.headers)
        headers.delete("content-type")
        headers.set("location", destination.href)
        headers.set("cache-control", "no-store")
        return new Response(null, { headers, status: 303 })
      }
      catch { return render(true) }
    },
  }
}

function consoleReturnPath(value: string | null, url: URL, mount: string): string {
  const fallback = `${mount}/_vitehub`
  if (!value || !/^\/(?!\/)[^\\\s]*$/.test(value)) return fallback
  const target = new URL(value, url)
  if (target.origin !== url.origin || !(target.pathname === fallback || target.pathname.startsWith(`${fallback}/`))) return fallback
  if (target.pathname === `${fallback}/sign-in`) return fallback
  return `${target.pathname}${target.search}${target.hash}`
}

export interface ConsoleAuthDefinition {
  auth: AuthDefinition
  authorize: AuthAccessAuthorize
  signIn: AuthSignInConfiguration
  migrate?: false
}

function isConsoleAuthResolver<T>(option: T | ((context: AuthRuntimeContext) => T)): option is (context: AuthRuntimeContext) => T {
  return typeof option === "function"
}

const migrations = new WeakMap<AuthDefinition, Promise<void>>()

export async function prepareConsoleAuth(
  input: ConsoleAuthDefinition,
  definition: AuthDefinition,
  request: Request,
  event?: unknown,
): Promise<void> {
  if (input.migrate === false) return
  let migration = migrations.get(definition)
  if (!migration) {
    migration = createAuthForRequest(definition, request, undefined, event).$context
      .then(context => context.runMigrations())
      .catch((error: unknown) => {
        migrations.delete(definition)
        throw error
      })
    migrations.set(definition, migration)
  }
  await migration
}

export function defineConsoleAuth(definition: ConsoleAuthDefinition): ConsoleAuthDefinition {
  if (!definition || typeof definition.authorize !== "function" || !definition.auth || !definition.signIn?.provider) {
    throw new TypeError("[vitehub] Console Auth requires an Auth Definition, an authorize callback, and a sign-in provider.")
  }
  return definition
}

export function createConsoleAuthDefinition(input: ConsoleAuthDefinition, mountBaseURL = "/"): AuthDefinition {
  const definition = defineConsoleAuth(input)
  // SAFETY: The resolver returns Better Auth options plus ViteHub Auth access metadata; AuthDefinition accepts this runtime option shape.
  return {
    options: (context: AuthRuntimeContext) => {
      const options: AuthResolvedDefinitionOptions & { runtime?: AuthRuntimeConfiguration } = isConsoleAuthResolver(definition.auth.options)
        ? definition.auth.options(context)
        : definition.auth.options
      const runtime = options.runtime
      const resolvedRuntime = isConsoleAuthResolver(runtime) ? runtime(context) : runtime
      const resolved = { ...options, ...resolvedRuntime }
      const database = resolved.database
      const databaseMetadata = database === true
        || (database !== null && typeof database === "object" && "name" in database && Object.keys(database).every(key => key === "name" || key === "dedicated"))
      if (!database || databaseMetadata) {
        throw new TypeError("[vitehub] Console Auth requires a Better Auth database adapter.")
      }
      if (!resolved.secret && !resolved.secrets) {
        throw new TypeError("[vitehub] Console Auth requires a secret.")
      }
      return {
        ...options,
        ...(runtime ? { runtime } : {}),
        access: {
          routes: [
            { route: consoleAuthPath(mountBaseURL, "/_vitehub/**"), authorize: definition.authorize },
            { route: consoleAuthPath(mountBaseURL, "/api/_vitehub/console/**"), authorize: definition.authorize },
          ],
          signIn: {
            callbackURL: consoleAuthPath(mountBaseURL, "/_vitehub"),
            errorCallbackURL: consoleAuthPath(mountBaseURL, "/_vitehub?auth_error=signin"),
            ...definition.signIn,
          },
        },
        advanced: {
          ...options.advanced,
          cookiePrefix: "vitehub_console",
        },
        basePath: consoleAuthPath(mountBaseURL, consoleAuthBasePath),
      }
    },
  } as AuthDefinition<AuthDefinitionInput>
}

/** The signed-in user that the Console gives `console.authorize`. */
export type ConsoleUser = AccessAuthorizationContext["user"]

/** The request that `console.authorize` checks. */
export interface ConsoleAuthorizeContext {
  request: Request
  /** The signed-in user with `auth: "app"` or a session-based Console Auth. Not set with `auth: false` or Cloudflare Access. */
  user?: ConsoleUser
}

/**
 * What `console.authorize` returns for one request.
 * - `true` allows every Console section.
 * - `{ sections }` allows only these section ids, for example `["content"]`. `"content:read"` allows only the operations of
 *   that section that read. An empty list is `403`.
 * - `false` is `403`. A `Response` is returned as-is.
 */
export type ConsoleAuthorizeResult = boolean | Response | { sections: readonly string[] }

/** Decides whether one Console request may continue, and which Console sections it may use. */
export type ConsoleAuthorize = (context: ConsoleAuthorizeContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>

/** Define the function that every Console data route calls. Set its file path as `console.authorize`. */
export function defineConsoleAuthorize(authorize: ConsoleAuthorize): ConsoleAuthorize {
  // Accept callbacks created in another JavaScript realm, where `instanceof Function` fails.
  if (typeof authorize !== "function") throw new TypeError("[vitehub] defineConsoleAuthorize() requires a function.")
  return authorize
}

const consoleSessionSchema = v.looseObject({ user: v.looseObject({ id: v.pipe(v.string(), v.minLength(1)) }) })

/** The part of a ViteHub Auth instance that reads the signed-in session. */
export interface ConsoleSessionReader {
  api: { getSession: (input: { headers: Headers }) => Promise<unknown> }
}

/**
 * Read the signed-in Console user from a ViteHub Auth instance. Returns `undefined` when the request has no session.
 * Session lookup errors propagate, so an action is never recorded for the wrong user.
 */
export async function readConsoleSessionUser(auth: ConsoleSessionReader, request: Pick<Request, "headers">): Promise<ConsoleUser | undefined> {
  const session = v.safeParse(consoleSessionSchema, await auth.api.getSession({ headers: request.headers }))
  return session.success ? session.output.user : undefined
}

/** The app Auth access routes that protect the Console, and the Auth functions that check them. */
export interface ConsoleAppAuthAccessOptions {
  getAuthForRequest: (request: Request, runtimeOptions: undefined, event: object) => ConsoleSessionReader
  requireAuthAccessRoutes: (event: object, routeIndexes: number[], definition: undefined, requiredAuthorizeRouteIndexes: number[], options: { redirectToSignIn: false }) => Promise<Response | undefined>
  /** Rejects a request without a session. Used for a Console path that no access route matches. */
  requireSession: (event: object) => Promise<Response | undefined>
  routes: readonly { authorize: boolean, index: number, method?: string, route: string }[]
}

/**
 * The Console access `check` and `user` for `console: { auth: "app" }`. The generated Console plugin calls this, so it
 * works for an H3 2 event and for an H3 1 event such as Nuxt 4's, which has no `url`.
 */
export function createConsoleAppAuthAccess(options: ConsoleAppAuthAccessOptions): {
  check: (event: object) => Promise<Response | undefined>
  user: (event: object) => Promise<ConsoleUser | undefined>
} {
  return {
    async check(event) {
      const request = toEventRequest(event)
      const path = consoleEventPath(event, request)
      const method = request.method.toUpperCase()
      const matched = options.routes.filter((route) => {
        if (route.method && route.method !== method) return false
        if (path === route.route) return true
        if (!route.route.endsWith("/**")) return false
        const base = route.route.slice(0, -3)
        return path === base || path.startsWith(`${base}/`)
      })
      if (!matched.length) return options.requireSession(event)
      const indexes = matched.map(route => route.index)
      const required = matched.filter(route => route.authorize).map(route => route.index)
      return options.requireAuthAccessRoutes(event, indexes, undefined, required, { redirectToSignIn: false })
    },
    user(event) {
      const request = toEventRequest(event)
      return readConsoleSessionUser(options.getAuthForRequest(request, undefined, event), request)
    },
  }
}
