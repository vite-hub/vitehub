import type { AuthAccessAuthorize, AuthDefinition, AuthDefinitionInput, AuthResolvedDefinitionOptions, AuthRuntimeConfiguration, AuthRuntimeContext, AuthSignInConfiguration } from "@vite-hub/auth"
import type { ConsoleAuthorize } from "./auth-types.ts"
import { createAuthForRequest } from "@vite-hub/auth/server"
import { consoleOAuthPlugins } from "./auth-oauth.ts"
import { consoleAuthBasePath } from "./auth-pages.ts"
import { consoleAuthPath } from "./auth-path.ts"

export { consoleMcpNativeClients, consoleMcpOAuth } from "./auth-oauth.ts"
export type { ConsoleMcpOAuthOptions } from "./auth-oauth.ts"
export { consoleAuthBasePath, consoleAuthPageResponse, consoleAuthSignInPage, consoleImpersonationPage, createConsoleAppAuthAccess, createConsoleAppAuthPages, readConsoleSessionUser } from "./auth-pages.ts"
export type { ConsoleAppAuthAccessOptions, ConsoleAppAuthInstance, ConsoleAppAuthResolver, ConsoleSessionReader } from "./auth-pages.ts"
export type { ConsoleAuthorize, ConsoleAuthorizeContext, ConsoleAuthorizeResult, ConsoleUser } from "./auth-types.ts"

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

export function createConsoleAuthDefinition(input: ConsoleAuthDefinition, mountBaseURL = "/", mcpResource?: string): AuthDefinition {
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
      // A managed schema supplies its own OAuth plugins; the schema-free registration hook is still needed.
      const oauth = consoleOAuthPlugins({ defaults: definition.migrate !== false, mountBaseURL, origin: context.requestOrigin, plugins: resolved.plugins, resource: mcpResource })
      const pluginsInRuntime = Boolean(resolvedRuntime && "plugins" in resolvedRuntime)
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
        ...(runtime ? { runtime: pluginsInRuntime && oauth.length ? { ...resolvedRuntime, plugins: [...resolved.plugins ?? [], ...oauth] } : runtime } : {}),
        ...(oauth.length && !pluginsInRuntime ? { plugins: [...options.plugins ?? [], ...oauth] } : {}),
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

/** Define the function that every Console data route calls. Set its file path as `console.authorize`. */
export function defineConsoleAuthorize(authorize: ConsoleAuthorize): ConsoleAuthorize {
  // Accept callbacks created in another JavaScript realm, where `instanceof Function` fails.
  if (typeof authorize !== "function") throw new TypeError("[vitehub] defineConsoleAuthorize() requires a function.")
  return authorize
}
