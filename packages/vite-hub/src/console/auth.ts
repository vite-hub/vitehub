import type { AuthAccessAuthorize, AuthDefinition, AuthDefinitionInput, AuthRuntimeContext, AuthSignInConfiguration } from "@vite-hub/auth"
import { createAuthForRequest } from "@vite-hub/auth/server"
import { consoleAuthPath } from "./auth-path.ts"

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
      a { display: inline-flex; min-height: 2.5rem; align-items: center; padding: 0 1rem; border-radius: .5rem; background: light-dark(#171717, #f5f5f5); color: light-dark(#fff, #171717); font-weight: 500; text-decoration: none; }
      a:focus-visible { outline: 2px solid #3b82f6; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Sign in</h1>
      <p>${message}</p>
      <a href="${escapeHTML(startPath)}">${escapeHTML(buttonLabel)}</a>
    </main>
  </body>
</html>`
  return new Response(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  })
}

export function consoleAuthPageResponse(request: Request, response: Response | undefined, mountBaseURL = "/"): Response | undefined {
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

  const signOutPath = consoleAuthPath(mountBaseURL, `${consoleAuthBasePath}/sign-out`)
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
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
    status: 403,
  })
}

export interface ConsoleAuthDefinition {
  auth: AuthDefinition
  authorize: AuthAccessAuthorize
  signIn: AuthSignInConfiguration
  migrate?: false
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A user-owned definition crosses the runtime module boundary, so reject a missing authorization callback.
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
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Auth Definitions may be static objects or request-scoped resolvers, and this is the documented discriminant.
      const options = typeof definition.auth.options === "function"
        ? definition.auth.options(context)
        : definition.auth.options
      const database = options.database
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Better Auth accepts adapter objects, while ViteHub Auth also accepts metadata objects that do not create a database.
      const databaseMetadata = database === true
        || (database !== null && typeof database === "object" && "name" in database && Object.keys(database).every(key => key === "name" || key === "dedicated"))
      if (!database || databaseMetadata) {
        throw new TypeError("[vitehub] Console Auth requires a Better Auth database adapter.")
      }
      if (!options.secret && !options.secrets) {
        throw new TypeError("[vitehub] Console Auth requires a secret.")
      }
      return {
        ...options,
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
