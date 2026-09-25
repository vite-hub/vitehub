import type { AuthAccessAuthorize, AuthDefinition, AuthDefinitionInput, AuthRuntimeContext, AuthSignInConfiguration } from "@vite-hub/auth"
import { createAuthForRequest } from "@vite-hub/auth/server"

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
  if (!definition || typeof definition.authorize !== "function" || !definition.auth || !definition.signIn?.provider) {
    throw new TypeError("[vitehub] Console Auth requires an Auth Definition, an authorize callback, and a sign-in provider.")
  }
  return definition
}

export function createConsoleAuthDefinition(input: ConsoleAuthDefinition): AuthDefinition {
  const definition = defineConsoleAuth(input)
  return {
    options: (context: AuthRuntimeContext) => {
      const options = typeof definition.auth.options === "function"
        ? definition.auth.options(context)
        : definition.auth.options
      const database = options.database
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
            { route: "/_vitehub/**", authorize: definition.authorize },
            { route: "/api/_vitehub/console/**", authorize: definition.authorize },
          ],
          signIn: {
            callbackURL: "/_vitehub",
            errorCallbackURL: "/_vitehub?auth_error=signin",
            ...definition.signIn,
          },
        },
        advanced: {
          ...options.advanced,
          cookiePrefix: "vitehub_console",
        },
        basePath: consoleAuthBasePath,
      }
    },
  } as AuthDefinition<AuthDefinitionInput>
}
