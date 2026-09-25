import type { AuthAccessAuthorize, AuthDefinition, AuthDefinitionInput, AuthRuntimeContext, AuthSignInConfiguration } from "@vite-hub/auth"
import { createAuthForRequest } from "@vite-hub/auth/server"
import { consoleAuthPath } from "./auth-path.ts"

export const consoleAuthBasePath = "/api/_vitehub/console/auth"

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
