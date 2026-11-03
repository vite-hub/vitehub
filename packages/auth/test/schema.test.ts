import { oauthProvider } from "@better-auth/oauth-provider"
import { getAuthTables } from "better-auth/db"
import { admin, jwt } from "better-auth/plugins"
import { getTableConfig as getPostgresTableConfig } from "drizzle-orm/pg-core"
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { authPostgresSchema, authSqliteSchema, authTableSpecs } from "../src/schema.ts"
import { assertAuthDatabaseSchema } from "../src/database-schema-options.ts"

import type { AuthTableField, AuthTableSpec } from "../src/schema.ts"

/** Better Auth's tables for the plugins that ViteHub ships, in the shape of `authTableSpecs`. */
function betterAuthTables(): Record<string, AuthTableSpec> {
  const tables = getAuthTables({ plugins: [admin(), jwt(), oauthProvider({ consentPage: "/sign-in", loginPage: "/sign-in" })] })
  return Object.fromEntries(Object.entries(tables).map(([model, table]) => {
    const fields = Object.fromEntries(Object.entries(table.fields).map(([key, field]) => {
      const spec: AuthTableField = { type: field.type as AuthTableField["type"] }
      if (field.required) spec.required = true
      if (field.unique) spec.unique = true
      if (field.index) spec.index = true
      const value: unknown = field.defaultValue
      if (value !== undefined) spec.defaultValue = typeof value === "function" ? "now" : value as AuthTableField["defaultValue"]
      if (field.onUpdate) spec.onUpdate = true
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
  it("accepts the shipped plugins and separately contributed plugin tables", () => {
    expect(() => assertAuthDatabaseSchema({ plugins: [admin(), jwt(), oauthProvider({ consentPage: "/sign-in", loginPage: "/sign-in" }), {
      id: "app-table",
      schema: { appTable: { fields: { value: { type: "string" } } } },
    }] })).not.toThrow()
  })

  it("match Better Auth's tables for admin(), jwt(), and oauthProvider()", () => {
    // A Better Auth upgrade that changes these tables fails here. Update `authTableSpecs` in src/schema.ts.
    expect(normalized(authTableSpecs)).toEqual(normalized(betterAuthTables()))
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
})
