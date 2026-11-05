// The Better Auth tables that Auth adds to the app Database. It imports only Drizzle, because the generated Database
// schema imports it when the server starts and Drizzle Kit loads it to write migrations.
import { sql } from "drizzle-orm"
import { boolean, index as pgIndex, integer as pgInteger, jsonb, pgTable, text as pgText, timestamp, uniqueIndex as pgUniqueIndex } from "drizzle-orm/pg-core"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import type { PgColumn, PgTableWithColumns } from "drizzle-orm/pg-core"
import type { SQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"

/** The keys of the Better Auth tables. Better Auth's Drizzle adapter finds each model by this key. */
export type AuthTableName =
  | "user"
  | "session"
  | "account"
  | "verification"
  | "jwks"
  | "oauthClient"
  | "oauthResource"
  | "oauthClientResource"
  | "oauthRefreshToken"
  | "oauthAccessToken"
  | "oauthConsent"
  | "oauthClientAssertion"

type AuthFieldType = "boolean" | "date" | "json" | "number" | "string" | "string[]"

/** One Better Auth field, in the shape of Better Auth's `getAuthTables()`. */
export interface AuthTableField {
  type: AuthFieldType
  required?: true
  unique?: true
  index?: true
  /** `"now"` is the current time. Better Auth sets the value itself; the column default keeps a plain SQL insert valid. */
  defaultValue?: boolean | number | readonly string[] | "now"
  onUpdate?: true
  references?: { model: AuthTableName, field: string, onDelete?: "cascade" | "set null" }
}

export interface AuthTableSpec {
  fields: Readonly<Record<string, AuthTableField>>
  /** Unique indexes on more than one field. */
  unique?: readonly (readonly string[])[]
}

const now = "now"
const requiredString = { type: "string", required: true } as const
const optionalString = { type: "string" } as const
const optionalDate = { type: "date" } as const
const optionalBoolean = { type: "boolean" } as const
const optionalJson = { type: "json" } as const
const optionalStrings = { type: "string[]" } as const
const requiredStrings = { type: "string[]", required: true } as const
const createdAt = { type: "date", required: true, defaultValue: now } as const
const userReference = { model: "user", field: "id", onDelete: "cascade" } as const
const clientReference = { model: "oauthClient", field: "clientId", onDelete: "cascade" } as const
const sessionReference = { model: "session", field: "id", onDelete: "set null" } as const

/**
 * The Better Auth core tables, with the fields of the plugins that ViteHub ships: `admin()` (`user.role`, bans, and
 * `session.impersonatedBy`), and the `jwt()` and `oauthProvider()` tables of `consoleMcpOAuth()`. A test checks this
 * list against Better Auth's own `getAuthTables()`, so a Better Auth upgrade that changes a table fails it.
 */
export const authTableSpecs: Readonly<Record<AuthTableName, AuthTableSpec>> = {
  user: {
    fields: {
      name: requiredString,
      email: { type: "string", required: true, unique: true },
      emailVerified: { type: "boolean", required: true, defaultValue: false },
      image: optionalString,
      createdAt,
      updatedAt: { type: "date", required: true, defaultValue: now, onUpdate: true },
      role: optionalString,
      banned: { type: "boolean", defaultValue: false },
      banReason: optionalString,
      banExpires: optionalDate,
    },
  },
  session: {
    fields: {
      expiresAt: { type: "date", required: true },
      token: { type: "string", required: true, unique: true },
      createdAt,
      updatedAt: { type: "date", required: true, onUpdate: true },
      ipAddress: optionalString,
      userAgent: optionalString,
      userId: { type: "string", required: true, index: true, references: userReference },
      impersonatedBy: optionalString,
    },
  },
  account: {
    fields: {
      accountId: requiredString,
      providerId: requiredString,
      userId: { type: "string", required: true, index: true, references: userReference },
      accessToken: optionalString,
      refreshToken: optionalString,
      idToken: optionalString,
      accessTokenExpiresAt: optionalDate,
      refreshTokenExpiresAt: optionalDate,
      scope: optionalString,
      password: optionalString,
      createdAt,
      updatedAt: { type: "date", required: true, onUpdate: true },
    },
  },
  verification: {
    fields: {
      identifier: { type: "string", required: true, index: true },
      value: requiredString,
      expiresAt: { type: "date", required: true },
      createdAt,
      updatedAt: { type: "date", required: true, defaultValue: now, onUpdate: true },
    },
  },
  jwks: {
    fields: {
      publicKey: requiredString,
      privateKey: requiredString,
      createdAt: { type: "date", required: true },
      expiresAt: optionalDate,
      alg: optionalString,
      crv: optionalString,
    },
  },
  oauthClient: {
    fields: {
      clientId: { type: "string", required: true, unique: true },
      clientSecret: optionalString,
      clientDiscoveryId: optionalString,
      disabled: { type: "boolean", defaultValue: false },
      skipConsent: optionalBoolean,
      enableEndSession: optionalBoolean,
      subjectType: optionalString,
      scopes: optionalStrings,
      clientCredentialsScopes: { type: "string[]", defaultValue: [] },
      userId: { type: "string", index: true, references: userReference },
      createdAt: optionalDate,
      updatedAt: optionalDate,
      name: optionalString,
      uri: optionalString,
      icon: optionalString,
      contacts: optionalStrings,
      tos: optionalString,
      policy: optionalString,
      softwareId: optionalString,
      softwareVersion: optionalString,
      softwareStatement: optionalString,
      redirectUris: requiredStrings,
      postLogoutRedirectUris: optionalStrings,
      backchannelLogoutUri: optionalString,
      backchannelLogoutSessionRequired: optionalBoolean,
      tokenEndpointAuthMethod: optionalString,
      applicationType: optionalString,
      jwks: optionalString,
      jwksUri: optionalString,
      grantTypes: optionalStrings,
      responseTypes: optionalStrings,
      requirePKCE: optionalBoolean,
      dpopBoundAccessTokens: { type: "boolean", defaultValue: false },
      referenceId: optionalString,
      metadata: optionalJson,
    },
  },
  oauthResource: {
    fields: {
      identifier: { type: "string", required: true, unique: true },
      name: requiredString,
      accessTokenTtl: { type: "number" },
      refreshTokenTtl: { type: "number" },
      signingAlgorithm: optionalString,
      signingKeyId: optionalString,
      allowedScopes: optionalStrings,
      customClaims: optionalJson,
      dpopBoundAccessTokensRequired: { type: "boolean", defaultValue: false },
      disabled: { type: "boolean", defaultValue: false },
      createdAt: optionalDate,
      updatedAt: optionalDate,
      policyVersion: { type: "number", defaultValue: 1 },
      metadata: optionalJson,
    },
  },
  oauthClientResource: {
    fields: {
      clientId: { type: "string", required: true, index: true, references: clientReference },
      resourceId: { type: "string", required: true, index: true, references: { model: "oauthResource", field: "identifier", onDelete: "cascade" } },
      metadata: optionalJson,
      createdAt: optionalDate,
    },
    unique: [["clientId", "resourceId"]],
  },
  oauthRefreshToken: {
    fields: {
      token: { type: "string", required: true, unique: true },
      clientId: { type: "string", required: true, index: true, references: clientReference },
      sessionId: { type: "string", index: true, references: sessionReference },
      userId: { type: "string", required: true, index: true, references: userReference },
      referenceId: optionalString,
      authorizationCodeId: { type: "string", index: true },
      resources: optionalStrings,
      requestedUserInfoClaims: optionalStrings,
      expiresAt: optionalDate,
      createdAt: optionalDate,
      revoked: optionalDate,
      rotatedAt: optionalDate,
      rotationReplayResponse: optionalString,
      rotationReplayExpiresAt: optionalDate,
      authTime: optionalDate,
      confirmation: optionalJson,
      scopes: requiredStrings,
    },
  },
  oauthAccessToken: {
    fields: {
      token: { type: "string", unique: true },
      clientId: { type: "string", required: true, index: true, references: clientReference },
      sessionId: { type: "string", index: true, references: sessionReference },
      userId: { type: "string", index: true, references: userReference },
      referenceId: optionalString,
      authorizationCodeId: { type: "string", index: true },
      resources: optionalStrings,
      requestedUserInfoClaims: optionalStrings,
      refreshId: { type: "string", index: true, references: { model: "oauthRefreshToken", field: "id", onDelete: "cascade" } },
      expiresAt: optionalDate,
      createdAt: optionalDate,
      revoked: optionalDate,
      confirmation: optionalJson,
      scopes: requiredStrings,
    },
  },
  oauthConsent: {
    fields: {
      clientId: { type: "string", required: true, index: true, references: clientReference },
      userId: { type: "string", index: true, references: userReference },
      referenceId: optionalString,
      resources: optionalStrings,
      requestedUserInfoClaims: optionalStrings,
      scopes: requiredStrings,
      createdAt: optionalDate,
      updatedAt: optionalDate,
    },
  },
  oauthClientAssertion: {
    fields: {
      expiresAt: { type: "date", required: true },
    },
  },
}

/** `emailVerified` becomes `email_verified` and `oauthClient` becomes `oauth_client`, as the Better Auth CLI writes them. */
function snakeCase(name: string): string {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase()
}

// The column builders of both dialects share these methods. Each builder returns itself, so the chain keeps one type.
interface ColumnChain<TColumn> {
  notNull(): ColumnChain<TColumn>
  unique(): ColumnChain<TColumn>
  default(value: unknown): ColumnChain<TColumn>
  $onUpdate(update: () => Date): ColumnChain<TColumn>
  references(target: () => TColumn, actions: { onDelete: "cascade" | "set null" }): ColumnChain<TColumn>
}

interface Dialect<TColumn, TTable> {
  column(name: string, field: AuthTableField): ColumnChain<TColumn>
  now: unknown
  table(name: string, columns: Record<string, ColumnChain<TColumn>>, indexes: (table: Record<string, TColumn>) => unknown[]): TTable
  index(name: string, unique: boolean, columns: TColumn[]): unknown
  id(): ColumnChain<TColumn>
}

function buildTables<TColumn, TTable>(dialect: Dialect<TColumn, TTable>): Record<AuthTableName, TTable> {
  const tables: Partial<Record<AuthTableName, TTable>> = {}
  const tableColumns = (model: AuthTableName): Record<string, TColumn> => {
    // SAFETY: Drizzle tables expose their columns as properties named by the column keys.
    return tables[model] as Record<string, TColumn>
  }
  for (const [model, spec] of Object.entries(authTableSpecs) as [AuthTableName, AuthTableSpec][]) {
    const columns: Record<string, ColumnChain<TColumn>> = { id: dialect.id() }
    const indexed: { name: string, unique: boolean, fields: readonly string[] }[] = []
    for (const [key, field] of Object.entries(spec.fields)) {
      let column = dialect.column(snakeCase(key), field)
      if (field.defaultValue !== undefined) column = column.default(field.defaultValue === now ? dialect.now : field.defaultValue)
      if (field.onUpdate) column = column.$onUpdate(() => new Date())
      if (field.required) column = column.notNull()
      if (field.unique) column = column.unique()
      const reference = field.references
      if (reference) column = column.references(() => tableColumns(reference.model)[reference.field]!, { onDelete: reference.onDelete ?? "cascade" })
      if (field.index) indexed.push({ name: `${model}_${key}_${field.unique ? "uidx" : "idx"}`, unique: Boolean(field.unique), fields: [key] })
      columns[key] = column
    }
    for (const fields of spec.unique ?? []) indexed.unshift({ name: `${model}_${fields.join("_")}_uidx`, unique: true, fields })
    tables[model] = dialect.table(snakeCase(model), columns, table => indexed.map(entry => dialect.index(entry.name, entry.unique, entry.fields.map(field => table[field]!))))
  }
  // SAFETY: The loop above sets every key of `authTableSpecs`.
  return tables as Record<AuthTableName, TTable>
}

/** A Better Auth table in a SQLite Database (SQLite, libSQL, or Cloudflare D1). */
export type AuthSqliteTable = SQLiteTableWithColumns<{ name: string, schema: undefined, columns: Record<string, SQLiteColumn>, dialect: "sqlite" }>

/** A Better Auth table in a Postgres Database. */
export type AuthPostgresTable = PgTableWithColumns<{ name: string, schema: undefined, columns: Record<string, PgColumn>, dialect: "pg" }>

/** The Better Auth tables for SQLite, libSQL, and Cloudflare D1. Auth adds them to the app Database. */
export type AuthSqliteSchema = Readonly<Record<AuthTableName, AuthSqliteTable>>

/** The Better Auth tables for Postgres. Auth adds them to the app Database. */
export type AuthPostgresSchema = Readonly<Record<AuthTableName, AuthPostgresTable>>

// SAFETY: Every Drizzle column builder has the chain methods; the casts give the two dialects one builder type.
export const authSqliteSchema: AuthSqliteSchema = buildTables<SQLiteColumn, AuthSqliteTable>({
  column(name, field) {
    const builder = field.type === "boolean"
      ? integer(name, { mode: "boolean" })
      : field.type === "date"
        ? integer(name, { mode: "timestamp_ms" })
        : field.type === "number"
          ? integer(name)
          : field.type === "string"
            ? text(name)
            : text(name, { mode: "json" })
    return builder as unknown as ColumnChain<SQLiteColumn>
  },
  id: () => text("id").primaryKey() as unknown as ColumnChain<SQLiteColumn>,
  index: (name, unique, columns) => (unique ? uniqueIndex(name) : index(name)).on(...columns as [SQLiteColumn, ...SQLiteColumn[]]),
  now: sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
  table: (name, columns, indexes) => sqliteTable(name, columns as never, table => indexes(table as unknown as Record<string, SQLiteColumn>) as never) as unknown as AuthSqliteTable,
})

export const authPostgresSchema: AuthPostgresSchema = buildTables<PgColumn, AuthPostgresTable>({
  column(name, field) {
    const builder = field.type === "boolean"
      ? boolean(name)
      : field.type === "date"
        ? timestamp(name)
        : field.type === "number"
          ? pgInteger(name)
          : field.type === "string"
            ? pgText(name)
            : field.type === "string[]"
              ? pgText(name).array()
              : jsonb(name)
    return builder as unknown as ColumnChain<PgColumn>
  },
  id: () => pgText("id").primaryKey() as unknown as ColumnChain<PgColumn>,
  index: (name, unique, columns) => (unique ? pgUniqueIndex(name) : pgIndex(name)).on(...columns as [PgColumn, ...PgColumn[]]),
  now: sql`now()`,
  table: (name, columns, indexes) => pgTable(name, columns as never, table => indexes(table as unknown as Record<string, PgColumn>) as never) as unknown as AuthPostgresTable,
})
