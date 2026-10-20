import { getActiveCloudflareBinding, getActiveCloudflareRequestScope } from "@vite-hub/internal/runtime/cloudflare-env"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { DatabaseConfigValue, PostgresDatabaseDefinition, RuntimePostgresDatabase } from "../types.ts"

/** Build-time values that apply when the evaluated Definition omits them. */
export interface PostgresDatabaseDefaults {
  binding: string
  url?: DatabaseConfigValue
}

interface PostgresInstance<TSchema extends Record<string, unknown>> {
  client: ReturnType<typeof postgres>
  db: RuntimePostgresDatabase<TSchema>
  url: string
}

function readHyperdriveConnectionString(binding: unknown) {
  if (!binding || Object(binding) !== binding) return
  const connectionString: unknown = Reflect.get(Object(binding), "connectionString")
  return typeof connectionString === "string" && connectionString ? connectionString : undefined
}

/**
 * Creates the Drizzle client for a Postgres Database Definition.
 *
 * A Cloudflare Hyperdrive binding takes precedence over `connection.url`. Inside a Cloudflare
 * request, each request gets its own client because Workers cannot reuse a socket across requests.
 * Outside a Cloudflare request, one client pool serves the process.
 */
export function createPostgresDatabase<TSchema extends Record<string, unknown>>(
  definition: PostgresDatabaseDefinition<TSchema>,
  defaults: PostgresDatabaseDefaults,
): RuntimePostgresDatabase<TSchema> {
  const bindingName = definition.cloudflare?.binding?.trim() || defaults.binding
  const requestInstances = new WeakMap<object, PostgresInstance<TSchema>>()
  let sharedInstance: PostgresInstance<TSchema> | undefined

  function resolveUrl() {
    const hyperdriveUrl = readHyperdriveConnectionString(getActiveCloudflareBinding<unknown>(bindingName))
    if (hyperdriveUrl) return hyperdriveUrl
    const url = resolveConfigValue(definition.connection?.url ?? defaults.url)?.trim()
    if (url) return url
    throw databaseErrorDiagnostics.DATABASE_MISSING_CONNECTION({ database: definition.name, needs: `the Cloudflare Hyperdrive binding "${bindingName}" or \`connection.url\`` })
  }

  function createInstance(url: string, requestScoped: boolean): PostgresInstance<TSchema> {
    // Cloudflare limits concurrent connections per request. Hyperdrive pools the origin connections.
    // Type discovery stays on, because array columns need the type metadata that postgres.js reads.
    const client = postgres(url, requestScoped ? { max: 5 } : {})
    const db: RuntimePostgresDatabase<TSchema> = drizzle({ casing: definition.drizzle.casing, client, schema: definition.schema })
    return { client, db, url }
  }

  function getDb() {
    const url = resolveUrl()
    const scope = getActiveCloudflareRequestScope()
    if (scope) {
      const cached = requestInstances.get(scope)
      if (cached?.url === url) return cached.db
      const instance = createInstance(url, true)
      requestInstances.set(scope, instance)
      return instance.db
    }

    if (sharedInstance?.url === url) return sharedInstance.db
    const previous = sharedInstance
    sharedInstance = createInstance(url, false)
    // end() lets queries that already started finish before it closes the superseded pool.
    void previous?.client.end()
    return sharedInstance.db
  }

  // SAFETY: Every property read forwards to the Drizzle database for the active request or process.
  return new Proxy({} as RuntimePostgresDatabase<TSchema>, {
    get(_, property) {
      const instance = getDb()
      const value: unknown = Reflect.get(instance, property)
      // Bind Drizzle methods. Own function values such as the postgres.js `$client` keep their properties.
      return typeof value === "function" && !Object.hasOwn(instance, property) ? value.bind(instance) : value
    },
  })
}
