import { createCloudflareProvisionClient, resolveCloudflareProvisionConfig } from "@vite-hub/internal/provision"

import { resolveConfigValue } from "./config-value.ts"
import { resolveDBViteConfig } from "./config.ts"

import type { ProvisionAction, ProvisionStep } from "@vite-hub/internal/provision"
import type { DBModulePublicOptions } from "./types.ts"

type DatabaseProvisionOptions = DBModulePublicOptions | (Exclude<DBModulePublicOptions, false> & { nuxtHostResource: true })

interface CloudflareD1Database {
  uuid?: string
  name?: string
}

interface PlannedDatabase {
  databaseName: string
  definitions: string[]
  nuxt: boolean
}

function parseDatabases(value: unknown): CloudflareD1Database[] {
  if (!Array.isArray(value)) throw new Error("Cloudflare provisioning returned an invalid database list.")
  // SAFETY: D1 database fields are optional and consumers narrow them before use.
  return value as CloudflareD1Database[]
}

function parseDatabase(value: unknown): CloudflareD1Database {
  if (!value || Object(value) !== value) throw new Error("Cloudflare provisioning returned an invalid database.")
  return value
}

export function getDatabaseNuxtProvisionStateKey(databaseName: string) {
  return encodeURIComponent(databaseName.trim())
}

// Resolves discovered Cloudflare D1 databases keyed by Database Definition name.
function planDatabases(rootDir: string, options: DatabaseProvisionOptions | undefined): PlannedDatabase[] {
  const config = resolveDBViteConfig(options, rootDir)
  const plannedByName = new Map<string, PlannedDatabase>()
  for (const definition of config?.databaseNames ?? []) {
    const cloudflare = config?.databases[definition]?.cloudflare
    const databaseName = resolveConfigValue(cloudflare?.databaseName)
    if (!databaseName) continue
    const matching = plannedByName.get(databaseName)
    if (matching) matching.definitions.push(definition)
    else plannedByName.set(databaseName, { databaseName, definitions: [definition], nuxt: false })
  }
  const integrationDatabaseName = options && options.driver === "d1" && "nuxtHostResource" in options && options.nuxtHostResource === true
    ? resolveConfigValue(options.databaseName)
    : undefined
  if (integrationDatabaseName) {
    const matching = plannedByName.get(integrationDatabaseName)
    if (matching) matching.nuxt = true
    else plannedByName.set(integrationDatabaseName, { databaseName: integrationDatabaseName, definitions: [], nuxt: true })
  }
  return [...plannedByName.values()]
}

export function createDatabaseProvisionStep(resolveRootDir: () => string, options?: DatabaseProvisionOptions): ProvisionStep {
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
      const listed = await request("/d1/database", { parse: parseDatabases })
      const idByName = new Map((listed.result ?? [])
        .filter((database): database is { name: string, uuid: string } => Boolean(database.name && database.uuid))
        .map(database => [database.name, database.uuid]))

      return planned.map(({ databaseName, definitions, nuxt }): ProvisionAction => {
        const existingId = idByName.get(databaseName)
        return {
          kind: "cloudflare-d1",
          name: databaseName,
          exists: Boolean(existingId),
          apply: async () => {
            let id = existingId
            if (!id) {
              const created = await request("/d1/database", { method: "POST", body: { name: databaseName }, parse: parseDatabase })
              id = created.result?.uuid
            }
            if (!id) return {}
            const definitionIds = Object.fromEntries(definitions.map(definition => [definition, id]))
            return { ids: { cloudflare: {
              ...(Object.keys(definitionIds).length ? { d1: definitionIds } : {}),
              ...(nuxt ? { d1Nuxt: { [getDatabaseNuxtProvisionStateKey(databaseName)]: id } } : {}),
            } } }
          },
        }
      })
    },
  }
}
