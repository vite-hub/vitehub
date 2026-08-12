import { createCloudflareProvisionClient, resolveCloudflareProvisionConfig } from "@vite-hub/internal/provision"

import { resolveConfigValue } from "./config-value.ts"
import { resolveDBViteConfig } from "./config.ts"

import type { ProvisionAction, ProvisionStep } from "@vite-hub/internal/provision"
import type { DBModulePublicOptions } from "./types.ts"

interface CloudflareD1Database {
  uuid?: string
  name?: string
}

interface PlannedDatabase {
  definition: string
  databaseName: string
}

export const databaseNuxtProvisionStateKey = "$nuxt"

// Resolves discovered Cloudflare D1 databases keyed by Database Definition name.
function planDatabases(rootDir: string, options: DBModulePublicOptions | undefined): PlannedDatabase[] {
  const config = resolveDBViteConfig(options, rootDir)
  const planned = config?.databaseNames.flatMap((definition) => {
    const cloudflare = config.databases[definition]?.cloudflare
    const databaseName = resolveConfigValue(cloudflare?.databaseName)
    return databaseName ? [{ definition, databaseName }] : []
  }) ?? []
  const integrationDatabaseName = options && options.driver === "d1"
    ? resolveConfigValue(options.databaseName)
    : undefined
  if (integrationDatabaseName && !planned.some(database => database.definition === "default" && database.databaseName === integrationDatabaseName)) {
    planned.push({ databaseName: integrationDatabaseName, definition: databaseNuxtProvisionStateKey })
  }
  return planned
}

export function createDatabaseProvisionStep(resolveRootDir: () => string, options?: DBModulePublicOptions): ProvisionStep {
  return {
    id: "database:cloudflare-d1",
    provider: "cloudflare",
    async plan(context) {
      const config = resolveCloudflareProvisionConfig(context.env)
      if (!config) {
        context.logger.warn("database: skipping Cloudflare D1, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN.")
        return []
      }

      const planned = planDatabases(resolveRootDir(), options)
      if (!planned.length) return []

      const request = createCloudflareProvisionClient(config, context.fetch)
      const listed = await request<CloudflareD1Database[]>("/d1/database")
      const idByName = new Map((listed.result ?? [])
        .filter((database): database is { name: string, uuid: string } => Boolean(database.name && database.uuid))
        .map(database => [database.name, database.uuid]))

      return planned.map(({ definition, databaseName }): ProvisionAction => {
        const existingId = idByName.get(databaseName)
        return {
          kind: "cloudflare-d1",
          name: databaseName,
          exists: Boolean(existingId),
          apply: async () => {
            let id = existingId
            if (!id) {
              const created = await request<CloudflareD1Database>("/d1/database", { method: "POST", body: { name: databaseName } })
              id = created.result?.uuid
            }
            return id ? { ids: { cloudflare: { d1: { [definition]: id } } } } : {}
          },
        }
      })
    },
  }
}
