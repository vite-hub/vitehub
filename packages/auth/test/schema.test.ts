import { apiKey } from "@better-auth/api-key"
import { oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import { stripe } from "@better-auth/stripe"
import { getAuthTables } from "better-auth/db"
import { getTableName } from "drizzle-orm"
import { admin, anonymous, jwt, lastLoginMethod, organization, phoneNumber, twoFactor, username } from "better-auth/plugins"
import Stripe from "stripe"
import { PgDialect, getTableConfig as getPostgresTableConfig } from "drizzle-orm/pg-core"
import { postgresJsCodecs } from "drizzle-orm/postgres-js"
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { authPluginSchemas, authPostgresSchema, authSqliteSchema, authTableSpecs, createAuthPostgresSchema, createAuthSqliteSchema, resolveAuthTableSpecs } from "../src/schema.ts"
import { authTableNames } from "../src/table-names.ts"
import { assertAuthDatabaseNames } from "../src/database-schema-options.ts"

import type { BetterAuthOptions } from "better-auth"
import type { AuthSchemaPlugin, AuthTableField, AuthTableSpec } from "../src/schema.ts"

const shippedPlugins = () => [admin(), jwt(), oauthProvider({ consentPage: "/sign-in", loginPage: "/sign-in" }), organization(), passkey()]

/** Better Auth's tables for `options`, in the shape of `authTableSpecs`. */
function betterAuthTables(options: BetterAuthOptions = { plugins: shippedPlugins(), rateLimit: { storage: "database" } }): Record<string, AuthTableSpec> {
  const tables = getAuthTables(options)
  return Object.fromEntries(Object.entries(tables).map(([model, table]) => {
    const fields = Object.fromEntries(Object.entries(table.fields).map(([key, field]) => {
      const spec: AuthTableField = { type: field.type as AuthTableField["type"] }
      if (field.required) spec.required = true
      if (field.unique) spec.unique = true
      if (field.index) spec.index = true
      const value: unknown = field.defaultValue
      if (value !== undefined) spec.defaultValue = typeof value === "function" ? "now" : value as AuthTableField["defaultValue"]
      if (field.onUpdate) spec.onUpdate = true
      if (field.bigint) spec.bigint = true
      if (field.references) spec.references = { model: field.references.model as never, field: field.references.field, onDelete: (field.references.onDelete ?? "cascade") as "cascade" }
      return [key, spec]
    }))
    const unique = table.indexes?.filter(index => index.unique).map(index => index.fields)
    return [model, { fields, ...(unique?.length ? { unique } : {}) }]
  }))
}

function normalized(specs: Readonly<Record<string, AuthTableSpec>>) {
  return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(specs).map(([model, spec]) => [model, {
    ...spec,
    fields: Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, { ...field, ...(field.references ? { references: { ...field.references, onDelete: field.references.onDelete ?? "cascade" } } : {}) }])),
  }]))))
}

describe("Auth tables", () => {
  it("accepts the shipped plugins and rejects renamed tables and columns", () => {
    expect(() => assertAuthDatabaseNames({ plugins: [...shippedPlugins(), twoFactor(), apiKey()] })).not.toThrow()
    expect(() => assertAuthDatabaseNames({ plugins: [apiKey({ schema: { apikey: { modelName: "api_keys" } } })] })).toThrow(/apikey.modelName/)
    expect(() => assertAuthDatabaseNames({ user: { fields: { email: "email_address" } } })).toThrow(/user.email cannot map/)
  })

  it("match Better Auth's tables for admin(), jwt(), oauthProvider(), organization(), and passkey()", () => {
    // A Better Auth upgrade that changes these tables fails here. Update `authTableSpecs` in src/schema.ts.
    const expected = betterAuthTables()
    // Better Auth omits this storage flag, but Postgres needs bigint for unsigned 32-bit counters.
    const expectedPasskey = expected.passkey!
    expectedPasskey.fields = { ...expectedPasskey.fields, counter: { ...expectedPasskey.fields.counter!, bigint: true } }
    expect(normalized(authTableSpecs)).toEqual(normalized(expected))
  })

  it("names SQLite and Postgres columns as the Better Auth CLI does", () => {
    for (const [model, spec] of Object.entries(authTableSpecs)) {
      const sqlite = getSqliteTableConfig(authSqliteSchema[model as keyof typeof authSqliteSchema])
      const postgres = getPostgresTableConfig(authPostgresSchema[model as keyof typeof authPostgresSchema])
      const keys = ["id", ...Object.keys(spec.fields)]
      for (const config of [sqlite, postgres]) {
        expect(config.columns.map(column => column.name)).toEqual(keys.map(key => key.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase()))
        expect(config.columns.filter(column => column.notNull && !column.primary).length).toBe(Object.values(spec.fields).filter(field => field.required).length)
        expect(config.foreignKeys.length).toBe(Object.values(spec.fields).filter(field => field.references).length)
      }
    }
    expect(getSqliteTableConfig(authSqliteSchema.oauthClient).name).toBe("oauth_client")
    expect(getSqliteTableConfig(authSqliteSchema.oauthClientResource).indexes.map(index => [index.config.name, index.config.unique])).toEqual([
      ["oauthClientResource_clientId_resourceId_uidx", true],
      ["oauthClientResource_clientId_idx", false],
      ["oauthClientResource_resourceId_idx", false],
    ])
  })

  it("stores the full unsigned 32-bit passkey counter range as JavaScript numbers", () => {
    const postgres = authPostgresSchema.passkey.counter!
    const sqlite = authSqliteSchema.passkey.counter!
    const dialect = new PgDialect({ codecs: postgresJsCodecs })
    expect(postgres.getSQLType()).toBe("bigint")
    expect(postgres.dataType).toBe("number int53")
    expect(sqlite.getSQLType()).toBe("integer")
    for (const counter of [0, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1]) {
      expect(postgres.mapToDriverValue(counter)).toBe(counter)
      expect(dialect.codecs.apply(postgres, "normalize", String(counter))).toBe(counter)
      expect(sqlite.mapFromDriverValue(counter)).toBe(counter)
    }
  })

  it("stores monthly API-key durations as JavaScript numbers in both dialects", () => {
    const postgres = createAuthPostgresSchema({ plugins: ["apiKey"] }).apikey!
    const sqlite = createAuthSqliteSchema({ plugins: ["apiKey"] }).apikey!
    const dialect = new PgDialect({ codecs: postgresJsCodecs })
    const duration = 30 * 24 * 60 * 60 * 1000
    for (const key of ["refillInterval", "rateLimitTimeWindow"]) {
      const column = postgres[key]!
      expect(column.getSQLType()).toBe("bigint")
      expect(column.dataType).toBe("number int53")
      expect(column.mapToDriverValue(duration)).toBe(duration)
      expect(dialect.codecs.apply(column, "normalize", String(duration))).toBe(duration)
      expect(sqlite[key]!.mapFromDriverValue(duration)).toBe(duration)
    }
  })

  // Each plugin with every option that adds a table or a column turned on.
  const pluginFactories: Record<AuthSchemaPlugin, () => NonNullable<BetterAuthOptions["plugins"]>[number]> = {
    anonymous: () => anonymous(),
    apiKey: () => apiKey(),
    lastLoginMethod: () => lastLoginMethod({ storeInDatabase: true }),
    phoneNumber: () => phoneNumber(),
    stripe: () => stripe({ stripeClient: new Stripe("sk_test_vitehub"), stripeWebhookSecret: "whsec_vitehub", subscription: { enabled: true, plans: [] }, organization: { enabled: true } }),
    twoFactor: () => twoFactor(),
    username: () => username(),
  }

  it.each(Object.keys(pluginFactories) as AuthSchemaPlugin[])("match Better Auth's tables and columns for %s()", (plugin) => {
    // A Better Auth upgrade that changes a plugin's tables fails here. Update `authPluginSchemas` in src/table-specs.ts.
    const core = betterAuthTables({})
    const expected = betterAuthTables({ plugins: [pluginFactories[plugin]()] })
    if (plugin === "apiKey") {
      // Millisecond durations can exceed Postgres's signed 32-bit integer range.
      const apikey = expected.apikey!
      apikey.fields = {
        ...apikey.fields,
        refillInterval: { ...apikey.fields.refillInterval!, bigint: true },
        rateLimitTimeWindow: { ...apikey.fields.rateLimitTimeWindow!, bigint: true },
      }
    }
    const fields: Record<string, Record<string, AuthTableField>> = {}
    const tables: Record<string, AuthTableSpec> = {}
    for (const [model, spec] of Object.entries(expected)) {
      if (!Object.hasOwn(authTableSpecs, model)) tables[model] = spec
      else {
        const added = Object.fromEntries(Object.entries(spec.fields).filter(([key]) => !Object.hasOwn(core[model]?.fields ?? {}, key)))
        if (Object.keys(added).length) fields[model] = added
      }
    }
    const schema = authPluginSchemas[plugin]
    expect(normalized(schema.tables ?? {})).toEqual(normalized(tables))
    expect(JSON.parse(JSON.stringify(schema.fields ?? {}))).toEqual(JSON.parse(JSON.stringify(fields)))
  })

  it("builds the plugin tables and additional columns for both dialects", () => {
    const options = {
      plugins: ["apiKey", "stripe", "twoFactor"] as const satisfies AuthSchemaPlugin[],
      additionalFields: { user: { login: { type: "string" } }, session: { device: { type: "string", index: true } } } as const,
    }
    const sqlite = createAuthSqliteSchema(options)
    const postgres = createAuthPostgresSchema(options)
    for (const describe of [(model: string) => getSqliteTableConfig(sqlite[model]!), (model: string) => getPostgresTableConfig(postgres[model]!)]) {
      expect(describe("apikey").name).toBe("apikey")
      expect(describe("twoFactor").name).toBe("two_factor")
      expect(describe("twoFactor").foreignKeys).toHaveLength(1)
      expect(describe("subscription").columns.map(column => column.name)).toContain("stripe_customer_id")
      expect(describe("user").columns.map(column => column.name)).toEqual(expect.arrayContaining(["login", "two_factor_enabled", "stripe_customer_id"]))
      expect(describe("session").indexes.map(index => index.config.name)).toContain("session_device_idx")
    }
    expect(Object.keys(sqlite)).toEqual(Object.keys(resolveAuthTableSpecs(options)))
    expect(Object.keys(postgres)).toEqual(Object.keys(resolveAuthTableSpecs(options)))
  })

  it("rejects fields that conflict with a table, and fields of a table that Auth does not create", () => {
    expect(() => resolveAuthTableSpecs({ additionalFields: { user: { emailVerified: { type: "string" } } } })).toThrow(expect.objectContaining({ code: "AUTH_C0056" }))
    expect(() => resolveAuthTableSpecs({ additionalFields: { user: { owner: { type: "string", references: { model: "team", field: "id" } } } } })).toThrow(/"team" table, which Auth does not create/)
    expect(Object.keys(resolveAuthTableSpecs({ additionalFields: { user: { role: { type: "string" } } } }).user!.fields)).toContain("role")
  })

  it("lists every schema key and SQL name for the Database contribution", () => {
    for (const schema of [authSqliteSchema, authPostgresSchema]) {
      expect(Object.fromEntries(Object.entries(schema).map(([key, table]) => [key, getTableName(table)]))).toEqual(authTableNames)
    }
  })
})
