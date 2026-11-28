// The Better Auth tables that Auth adds to the app Database, built with Drizzle from the specs of `table-specs.ts`. The
// generated Database schema imports it when the server starts, and Drizzle Kit loads it to write migrations.
import { defineRelationsPart, isTable, sql } from "drizzle-orm"
import { bigint as pgBigint, boolean, foreignKey as pgForeignKey, index as pgIndex, integer as pgInteger, jsonb, pgTable, text as pgText, timestamp, uniqueIndex as pgUniqueIndex } from "drizzle-orm/pg-core"
import { customType, foreignKey as sqliteForeignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import { authSqlName, authTableSpecs, resolveAuthTableSpecs } from "./table-specs.ts"

import type { AuthExistingColumn, AuthExistingTables } from "./existing-tables.ts"
import type { AuthCoreModel, AuthCoreTableSpecs, AuthPluginSchemas, AuthSchemaOptions, AuthSchemaPlugin, AuthTableField, AuthTableName, AuthTableSpec } from "./table-specs.ts"

export { authPluginSchemas, authTableSpecs, resolveAuthTableSpecs } from "./table-specs.ts"
export type { AuthCoreModel, AuthCoreTableSpecs, AuthPluginSchemas, AuthSchemaOptions, AuthSchemaPlugin, AuthTableField, AuthTableName, AuthTableSpec } from "./table-specs.ts"
import type { $Type, AnyRelation, AnyRelations, BuildColumns, ExtractTablesFromSchema, ExtractTablesWithRelationsParts, HasDefault, IsPrimaryKey, Many, NotNull, One, RelationsRecord, Table } from "drizzle-orm"
import type { PgBigInt53Builder, PgBooleanBuilder, PgBuildColumns, PgColumn, PgIntegerBuilder, PgJsonbBuilder, PgTableWithColumns, PgTextBuilder, PgTimestampBuilder } from "drizzle-orm/pg-core"
import type { SQLiteBooleanBuilder, SQLiteColumn, SQLiteIntegerBuilder, SQLiteTableWithColumns, SQLiteTextBuilder, SQLiteTextJsonBuilder, SQLiteTimestampBuilder } from "drizzle-orm/sqlite-core"

// The column builders of both dialects share these methods. Each builder returns itself, so the chain keeps one type.
interface ColumnChain<TColumn> {
  notNull(): ColumnChain<TColumn>
  unique(name?: string): ColumnChain<TColumn>
  default(value: unknown): ColumnChain<TColumn>
  $onUpdate(update: () => Date): ColumnChain<TColumn>
  references(target: () => TColumn, actions: { onDelete: ForeignKeyAction, onUpdate?: ForeignKeyAction }): ColumnChain<TColumn>
}

type ForeignKeyAction = "cascade" | "no action" | "restrict" | "set default" | "set null"

interface Dialect<TColumn, TTable> {
  column(name: string, field: AuthTableField): ColumnChain<TColumn>
  now: unknown
  /** The current time in milliseconds, for a `number` column. */
  nowMs: unknown
  /** A column default from its SQL text. */
  raw(sqlText: string): unknown
  table(name: string, columns: Record<string, ColumnChain<TColumn>>, extras: (table: Record<string, TColumn>) => unknown[]): TTable
  index(name: string, unique: boolean, columns: TColumn[]): unknown
  foreignKey(name: string, columns: TColumn[], foreignColumns: TColumn[], actions: { onDelete: ForeignKeyAction, onUpdate: ForeignKeyAction }): unknown
  id(): ColumnChain<TColumn>
}

const sameColumns = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((column, index) => column === right[index])

const foreignKeyAction = (action: string) => action.toLowerCase() as ForeignKeyAction

function buildTables<TColumn, TTable>(dialect: Dialect<TColumn, TTable>, specs: Readonly<Record<string, AuthTableSpec>>, existing?: AuthExistingTables): Record<string, TTable> {
  const tables: Record<string, TTable> = {}
  const tableColumns = (model: string): Record<string, TColumn> => {
    // SAFETY: Drizzle tables expose their columns as properties named by the column keys.
    return tables[model] as Record<string, TColumn>
  }
  const modelBySqlName = new Map(Object.keys(specs).map(model => [authSqlName(model), model]))
  for (const [model, spec] of Object.entries(specs)) {
    // A table that the Database has already keeps what only a table rebuild could change. See `existing-tables.ts`.
    const current = existing && Object.hasOwn(existing, authSqlName(model)) ? existing[authSqlName(model)] : undefined
    const columns: Record<string, ColumnChain<TColumn>> = { id: dialect.id() }
    const indexed: { name: string, unique: boolean, fields: readonly string[] }[] = []
    const foreignKeys: { name: string, fields: readonly string[], model: string, foreignFields: readonly string[], onDelete: ForeignKeyAction, onUpdate: ForeignKeyAction }[] = []
    // The name of an index that the table has on the same columns, so that the index is not dropped and created again.
    const indexName = (fields: readonly string[], unique: boolean, name: string) =>
      current?.indexes.find(entry => entry.unique === unique && sameColumns(entry.columns, fields.map(authSqlName)))?.name ?? name
    for (const [key, field] of Object.entries(spec.fields)) {
      const name = authSqlName(key)
      const column = current && Object.hasOwn(current.columns, name) ? current.columns[name] : undefined
      let builder = dialect.column(name, field)
      if (column) {
        if (column.default !== undefined) builder = builder.default(dialect.raw(column.default))
      }
      else if (field.defaultValue !== undefined) {
        builder = builder.default(field.defaultValue === "now" && field.type !== "string" ? field.type === "number" ? dialect.nowMs : dialect.now : field.defaultValue)
      }
      if (field.onUpdate) builder = builder.$onUpdate(() => new Date())
      // Existing columns keep their nullability, including optional Auth fields. SQLite adds a new NOT NULL column
      // only with a default; Better Auth writes required fields, so other additions can stay nullable.
      if (column ? column.notNull : field.required && (!current || field.defaultValue !== undefined)) builder = builder.notNull()
      if (field.unique) {
        const constraint = current?.uniques.find(entry => sameColumns(entry.columns, [name]))
        // A unique index is added and dropped without a rebuild; a UNIQUE constraint is not.
        if (!current || constraint) builder = builder.unique(constraint?.name)
        else if (!field.index) indexed.push({ name: indexName([key], true, `${model}_${key}_uidx`), unique: true, fields: [key] })
      }
      const reference = field.references
      if (reference) {
        const foreignKey = current?.foreignKeys.find(entry => sameColumns(entry.columns, [name]))
        const sameTarget = foreignKey?.tableTo === authSqlName(reference.model) && sameColumns(foreignKey.columnsTo, [authSqlName(reference.field)])
        if (!current || (foreignKey && !sameTarget)) {
          builder = builder.references(() => tableColumns(reference.model)[reference.field]!, { onDelete: reference.onDelete ?? "cascade" })
        }
        else if (foreignKey?.name) {
          foreignKeys.push({ name: foreignKey.name, fields: [key], model: reference.model, foreignFields: [reference.field], onDelete: foreignKeyAction(foreignKey.onDelete), onUpdate: foreignKeyAction(foreignKey.onUpdate) })
        }
        else if (foreignKey) {
          builder = builder.references(() => tableColumns(reference.model)[reference.field]!, { onDelete: foreignKeyAction(foreignKey.onDelete), onUpdate: foreignKeyAction(foreignKey.onUpdate) })
        }
        // Without a foreign key on the column, the table stays without one: adding it needs a rebuild.
      }
      if (field.index) indexed.push({ name: indexName([key], Boolean(field.unique), `${model}_${key}_${field.unique ? "uidx" : "idx"}`), unique: Boolean(field.unique), fields: [key] })
      columns[key] = builder
    }
    for (const fields of spec.unique ?? []) indexed.unshift({ name: indexName(fields, true, `${model}_${fields.join("_")}_uidx`), unique: true, fields })
    // Other indexes of the table stay too, such as a unique index that the app added, so the migration drops no index.
    const fieldOf = (column: string) => column === "id" ? "id" : Object.keys(spec.fields).find(key => authSqlName(key) === column)
    for (const index of current?.indexes ?? []) {
      const fields = index.columns.map(fieldOf)
      if (indexed.some(entry => entry.name === index.name) || fields.some(field => !field)) continue
      const constraint = index.unique && fields.length === 1 && current?.uniques.some(entry => sameColumns(entry.columns, index.columns))
      if (!constraint) indexed.push({ name: index.name, unique: index.unique, fields: fields as string[] })
    }
    // Foreign keys of the table on other columns, to another Auth table, stay too.
    for (const foreignKey of current?.foreignKeys ?? []) {
      const fields = foreignKey.columns.map(fieldOf)
      const target = modelBySqlName.get(foreignKey.tableTo)
      const targetSpec = target ? specs[target] : undefined
      const foreignFields = foreignKey.columnsTo.map(column => column === "id" ? "id" : Object.keys(targetSpec?.fields ?? {}).find(key => authSqlName(key) === column))
      if (!target || fields.some(field => !field) || foreignFields.some(field => !field)) continue
      if (fields.length === 1 && spec.fields[fields[0]!]?.references) continue
      foreignKeys.push({ name: foreignKey.name ?? `${authSqlName(model)}_${foreignKey.columns.join("_")}_${foreignKey.tableTo}_${foreignKey.columnsTo.join("_")}_fk`, fields: fields as string[], model: target, foreignFields: foreignFields as string[], onDelete: foreignKeyAction(foreignKey.onDelete), onUpdate: foreignKeyAction(foreignKey.onUpdate) })
    }
    tables[model] = dialect.table(authSqlName(model), columns, table => [
      ...indexed.map(entry => dialect.index(entry.name, entry.unique, entry.fields.map(field => table[field]!))),
      ...foreignKeys.map(entry => dialect.foreignKey(entry.name, entry.fields.map(field => table[field]!), entry.foreignFields.map(field => tableColumns(entry.model)[field]!), entry)),
    ])
  }
  return tables
}

/** A Better Auth table in a SQLite Database (SQLite, libSQL, or Cloudflare D1), with untyped columns. */
export type AuthSqliteTable = SQLiteTableWithColumns<{ name: string, schema: undefined, columns: Record<string, SQLiteColumn>, dialect: "sqlite", isAlias: false }>

/** A Better Auth table in a Postgres Database, with untyped columns. */
export type AuthPostgresTable = PgTableWithColumns<{ name: string, schema: undefined, columns: Record<string, PgColumn>, dialect: "pg", isAlias: false }>

// The column types of the core tables come from the literal of `authTableSpecs`, so app queries and app foreign keys to
// `user` or `organization` are typed.
type FieldData<F> = F extends { type: "boolean" } ? boolean
  : F extends { type: "date" } ? Date
    : F extends { type: "number" } ? number
      : F extends { type: "string" } ? string
        : F extends { type: "string[]" } ? string[]
          : F extends { type: "number[]" } ? number[]
            : unknown

type WithDefault<TBuilder, TDefault extends boolean> = TDefault extends true ? HasDefault<TBuilder> : TBuilder
type WithColumnConstraints<TBuilder, TRequired extends boolean, TDefault extends boolean> = TRequired extends true
  ? NotNull<WithDefault<TBuilder, TDefault>>
  : WithDefault<TBuilder, TDefault>

type HasValue<TValue> = undefined extends TValue ? false : true
type FieldDefault<TField> = TField extends { defaultValue: infer TValue } ? HasValue<TValue> : false
type HasFieldDefault<TField> = false extends FieldDefault<TField> ? false : true
type InsertDefault<TField, TDefault extends boolean> = [TField] extends [{ onUpdate: true }] ? true : TDefault
type FieldRequired<TField> = [TField] extends [{ required: true }] ? true : false

type WithConstraints<TBuilder, TField> = WithColumnConstraints<TBuilder, FieldRequired<TField>, InsertDefault<TField, HasFieldDefault<TField>>>

type SqliteBuilder<F> = F extends { type: "boolean" } ? SQLiteBooleanBuilder
  : F extends { type: "date" } ? SQLiteTimestampBuilder
    : F extends { type: "number" } ? SQLiteIntegerBuilder
      : F extends { type: "string" } ? SQLiteTextBuilder<[string, ...string[]]>
        : $Type<SQLiteTextJsonBuilder, FieldData<F>>

type PostgresBuilder<F> = F extends { type: "boolean" } ? PgBooleanBuilder
  : F extends { type: "date" } ? PgTimestampBuilder
    : F extends { type: "number" } ? F extends { bigint: true } ? PgBigInt53Builder : PgIntegerBuilder
      : F extends { type: "string" } ? PgTextBuilder
        : F extends { type: "json" } ? PgJsonbBuilder
          : $Type<PgTextBuilder, FieldData<F>>

type WithSqliteConstraints<TBuilder, TField, TColumns, TName extends string> =
  [TColumns] extends [never] ? WithConstraints<TBuilder, TField>
    : [TColumns] extends [Record<TName, infer TColumn extends AuthExistingColumn>]
      ? WithColumnConstraints<TBuilder, [TColumn] extends [{ notNull: true }] ? true : false, InsertDefault<TField, [TColumn] extends [{ default: string }] ? true : false>>
      : WithColumnConstraints<TBuilder, HasFieldDefault<TField> extends true ? FieldRequired<TField> : false, InsertDefault<TField, HasFieldDefault<TField>>>

type SqliteColumns<TFields, TExistingColumns> = { id: IsPrimaryKey<SQLiteTextBuilder<[string, ...string[]]>> } & {
  -readonly [K in keyof TFields]: WithSqliteConstraints<SqliteBuilder<TFields[K]>, TFields[K], TExistingColumns, SqlName<K & string>>
}

type PostgresColumns<TFields> = { id: IsPrimaryKey<PgTextBuilder> } & { -readonly [K in keyof TFields]: WithConstraints<PostgresBuilder<TFields[K]>, TFields[K]> }

/** A SQLite table with a typed column for each field of `TFields`. */
export type AuthSqliteTableOf<TFields, TExistingColumns = never> = SQLiteTableWithColumns<{
  name: string
  schema: undefined
  columns: BuildColumns<string, SqliteColumns<TFields, TExistingColumns>, "sqlite">
  dialect: "sqlite"
  isAlias: false
}>

/** A Postgres table with a typed column for each field of `TFields`. */
export type AuthPostgresTableOf<TFields> = PgTableWithColumns<{
  name: string
  schema: undefined
  columns: PgBuildColumns<string, PostgresColumns<TFields>>
  dialect: "pg"
  isAlias: false
}>

/** The Better Auth table `TModel` in a SQLite Database, with a typed column for each field. */
export type AuthSqliteCoreTable<TModel extends AuthTableName> = AuthSqliteTableOf<AuthCoreTableSpecs[TModel]["fields"]>

/** The Better Auth table `TModel` in a Postgres Database, with a typed column for each field. */
export type AuthPostgresCoreTable<TModel extends AuthTableName> = AuthPostgresTableOf<AuthCoreTableSpecs[TModel]["fields"]>

/** The Better Auth tables for SQLite, libSQL, and Cloudflare D1. Auth adds them to the app Database. */
export type AuthSqliteSchema = { readonly [TModel in AuthTableName]: AuthSqliteCoreTable<TModel> }

/** The Better Auth tables for Postgres. Auth adds them to the app Database. */
export type AuthPostgresSchema = { readonly [TModel in AuthTableName]: AuthPostgresCoreTable<TModel> }

// The tables of `createAuthSqliteSchema(options)` and `createAuthPostgresSchema(options)`, typed from the literal of
// `options` as the Auth Vite plugin writes it: the plugin tables, and the plugin and additional columns of each table.
// Options with a wide type, such as a variable of type `AuthSchemaOptions`, give the core tables.

/** The fields of a union of field records, keyed by every key of the union. */
type MergeFields<TUnion> = { [K in TUnion extends unknown ? keyof TUnion : never]: TUnion extends { readonly [P in K]: infer TField } ? TField : never }

/** `TFirst` wins a key that both have, as `resolveAuthTableSpecs()` keeps the column that a table has already. */
type Prefer<TFirst, TSecond> = TFirst & Omit<TSecond, keyof TFirst>

type HasPlugin<TPlugins, TPlugin> = TPlugins extends readonly [infer TFirst, ...infer TRest]
  ? [TFirst] extends [TPlugin] ? true : HasPlugin<TRest, TPlugin>
  : TPlugins extends readonly [...infer TRest, infer TLast]
    ? [TLast] extends [TPlugin] ? true : HasPlugin<TRest, TPlugin>
    : false

type SchemaPlugins<TOptions> = [TOptions] extends [{ plugins: infer TPlugins }]
  ? { [P in AuthSchemaPlugin]: false extends HasPlugin<TPlugins, P> ? never : P }[AuthSchemaPlugin]
  : never

type PluginFields<TPlugin extends AuthSchemaPlugin, TModel extends string> = TPlugin extends unknown
  ? AuthPluginSchemas[TPlugin] extends { fields: { readonly [K in TModel]: infer TFields } } ? TFields : never
  : never

type PluginTables<TPlugin extends AuthSchemaPlugin> = MergeFields<TPlugin extends unknown
  ? AuthPluginSchemas[TPlugin] extends { tables: infer TTables } ? TTables : never
  : never>

type GuaranteedFieldKeys<TFields, TKey = keyof TFields> = TKey extends keyof TFields
  ? string extends TKey ? never : [TFields] extends [Record<TKey, AuthTableField>] ? TKey : never
  : never

type AdditionalFields<TOptions, TModel extends string> = TModel extends AuthCoreModel
  ? [TOptions] extends [{ additionalFields: { readonly [K in TModel]: infer TFields } }]
    ? Pick<TFields, GuaranteedFieldKeys<TFields>>
    : {}
  : {}

type TableFields<TOptions, TModel extends AuthTableName> = Prefer<
  Prefer<AuthCoreTableSpecs[TModel]["fields"], MergeFields<PluginFields<SchemaPlugins<TOptions>, TModel>>>,
  AdditionalFields<TOptions, TModel>
>

type PluginTableFields<TOptions, TTable extends keyof PluginTables<SchemaPlugins<TOptions>>> =
  PluginTables<SchemaPlugins<TOptions>>[TTable] extends { fields: infer TFields } ? TFields : never

type Lower = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z"
type Upper = Uppercase<Lower>
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"

/** The same word boundaries as `authSqlName()`, for lookup in a migration snapshot. */
type SqlName<TName extends string, TPrevious extends string = "", TResult extends string = ""> =
  TName extends `${infer TChar}${infer TRest}`
    ? SqlName<TRest, TChar, `${TResult}${TChar extends Upper
      ? TPrevious extends Lower | Digit ? "_" : TPrevious extends Upper ? TRest extends `${Lower}${string}` ? "_" : "" : ""
      : ""}${Lowercase<TChar>}`>
    : TResult

type ExistingColumns<TExisting, TModel extends string> =
  [TExisting] extends [Record<SqlName<TModel>, { columns: infer TColumns }>] ? TColumns : never

/** The Better Auth tables for SQLite, with fields from `TOptions` and constraints from a literal migration snapshot. */
export type AuthSqliteSchemaFor<TOptions extends AuthSchemaOptions, TExisting extends AuthExistingTables | undefined = undefined> =
  & { readonly [TModel in AuthTableName]: AuthSqliteTableOf<TableFields<TOptions, TModel>, ExistingColumns<TExisting, TModel>> }
  & { readonly [TTable in keyof PluginTables<SchemaPlugins<TOptions>>]: AuthSqliteTableOf<PluginTableFields<TOptions, TTable>, ExistingColumns<TExisting, TTable & string>> }

/** The Better Auth tables for Postgres, with the plugin tables and the plugin and additional columns of `TOptions`. */
export type AuthPostgresSchemaFor<TOptions extends AuthSchemaOptions> =
  & { readonly [TModel in AuthTableName]: AuthPostgresTableOf<TableFields<TOptions, TModel>> }
  & { readonly [TTable in keyof PluginTables<SchemaPlugins<TOptions>>]: AuthPostgresTableOf<PluginTableFields<TOptions, TTable>> }

type CoreAuthRelationConfig = {
  user: {
    sessions: Many<"session">
    accounts: Many<"account">
    oauthClients: Many<"oauthClient">
    oauthRefreshTokens: Many<"oauthRefreshToken">
    oauthAccessTokens: Many<"oauthAccessToken">
    oauthConsents: Many<"oauthConsent">
    members: Many<"member">
    invitations: Many<"invitation">
    passkeys: Many<"passkey">
  }
  session: {
    user: One<"user", true>
    oauthRefreshTokens: Many<"oauthRefreshToken">
    oauthAccessTokens: Many<"oauthAccessToken">
  }
  account: {
    user: One<"user", true>
  }
  oauthClient: {
    user: One<"user", true>
    oauthClientResources: Many<"oauthClientResource">
    oauthRefreshTokens: Many<"oauthRefreshToken">
    oauthAccessTokens: Many<"oauthAccessToken">
    oauthConsents: Many<"oauthConsent">
  }
  oauthResource: {
    oauthClientResources: Many<"oauthClientResource">
  }
  oauthClientResource: {
    oauthClient: One<"oauthClient", true>
    oauthResource: One<"oauthResource", true>
  }
  oauthRefreshToken: {
    oauthClient: One<"oauthClient", true>
    session: One<"session", true>
    user: One<"user", true>
    oauthAccessTokens: Many<"oauthAccessToken">
  }
  oauthAccessToken: {
    oauthClient: One<"oauthClient", true>
    session: One<"session", true>
    user: One<"user", true>
    oauthRefreshToken: One<"oauthRefreshToken", true>
  }
  oauthConsent: {
    oauthClient: One<"oauthClient", true>
    user: One<"user", true>
  }
  organization: {
    members: Many<"member">
    invitations: Many<"invitation">
  }
  member: {
    organization: One<"organization", true>
    user: One<"user", true>
  }
  invitation: {
    organization: One<"organization", true>
    user: One<"user", true>
  }
  passkey: {
    user: One<"user", true>
  }
}

type TwoFactorAuthRelationConfig = Omit<CoreAuthRelationConfig, "user"> & {
  user: CoreAuthRelationConfig["user"] & { twoFactors: Many<"twoFactor"> }
  twoFactor: { user: One<"user", true> }
}

type BaseAuthRelationConfig<TOptions extends AuthSchemaOptions> =
  "twoFactor" extends SchemaPlugins<TOptions> ? TwoFactorAuthRelationConfig : CoreAuthRelationConfig

type BaseTableFields<TOptions, TModel extends AuthTableName> =
  Prefer<AuthCoreTableSpecs[TModel]["fields"], MergeFields<PluginFields<SchemaPlugins<TOptions>, TModel>>>

type ExtraAdditionalFields<TOptions, TModel extends AuthCoreModel> =
  Omit<AdditionalFields<TOptions, TModel>, keyof BaseTableFields<TOptions, TModel>>

type AuthSchemaTableNames<TOptions> = AuthTableName | (keyof PluginTables<SchemaPlugins<TOptions>> & string)

type PluralizeModel<TModel extends string> = TModel extends `${string}s` ? TModel : `${TModel}s`

type AdditionalForwardRelations<TOptions, TModel extends string> =
  TModel extends AuthCoreModel
    ? {
        [F in keyof ExtraAdditionalFields<TOptions, TModel> as ExtraAdditionalFields<TOptions, TModel>[F] extends { readonly references: { readonly model: infer TTarget extends AuthSchemaTableNames<TOptions> } }
          ? `${F & string}${Capitalize<TTarget>}`
          : never]: ExtraAdditionalFields<TOptions, TModel>[F] extends { readonly references: { readonly model: infer TTarget extends AuthSchemaTableNames<TOptions> } }
          ? One<TTarget, true>
          : never
      }
    : {}

type AdditionalReverseRelationsForSource<TOptions, TSource extends AuthCoreModel, TTarget extends string> = {
  [F in keyof ExtraAdditionalFields<TOptions, TSource> as ExtraAdditionalFields<TOptions, TSource>[F] extends { readonly references: { readonly model: TTarget } }
    ? ExtraAdditionalFields<TOptions, TSource>[F] extends { readonly unique: true }
      ? `${TSource}By${Capitalize<F & string>}`
      : `${PluralizeModel<TSource>}By${Capitalize<F & string>}`
    : never]: ExtraAdditionalFields<TOptions, TSource>[F] extends { readonly unique: true }
    ? One<TSource, true>
    : Many<TSource>
}

type AdditionalReverseRelations<TOptions, TTarget extends string> =
  & AdditionalReverseRelationsForSource<TOptions, "user", TTarget>
  & AdditionalReverseRelationsForSource<TOptions, "session", TTarget>
  & AdditionalReverseRelationsForSource<TOptions, "account", TTarget>
  & AdditionalReverseRelationsForSource<TOptions, "verification", TTarget>

type ModelBaseRelations<TOptions extends AuthSchemaOptions, TModel extends string> =
  TModel extends keyof BaseAuthRelationConfig<TOptions> ? BaseAuthRelationConfig<TOptions>[TModel] : {}

type ModelAllRelations<TOptions extends AuthSchemaOptions, TModel extends string> =
  Prefer<
    ModelBaseRelations<TOptions, TModel>,
    Prefer<
      AdditionalForwardRelations<TOptions, TModel>,
      AdditionalReverseRelations<TOptions, TModel>
    >
  >

type TableColumnKeys<TOptions extends AuthSchemaOptions, TModel extends string> =
  TModel extends AuthTableName
    ? "id" | (keyof TableFields<TOptions, TModel> & string)
    : TModel extends keyof PluginTables<SchemaPlugins<TOptions>>
      ? "id" | (keyof PluginTableFields<TOptions, TModel> & string)
      : "id"

type ModelRelations<TOptions extends AuthSchemaOptions, TModel extends string> = {
  [K in Exclude<keyof ModelAllRelations<TOptions, TModel>, TableColumnKeys<TOptions, TModel>>]: ModelAllRelations<TOptions, TModel>[K] extends AnyRelation
    ? ModelAllRelations<TOptions, TModel>[K]
    : never
}

type AuthRelationConfig<TOptions extends AuthSchemaOptions = {}> = {
  [TModel in AuthSchemaTableNames<TOptions> as keyof ModelRelations<TOptions, TModel> extends never ? never : TModel]: ModelRelations<TOptions, TModel>
}

/** The Drizzle v1 relations for `authSqliteSchema`. */
export type AuthSqliteRelations = ExtractTablesWithRelationsParts<CoreAuthRelationConfig, ExtractTablesFromSchema<AuthSqliteSchema>>

/** The Drizzle v1 relations for `authPostgresSchema`. */
export type AuthPostgresRelations = ExtractTablesWithRelationsParts<CoreAuthRelationConfig, ExtractTablesFromSchema<AuthPostgresSchema>>

/** The Drizzle v1 relations for the Auth tables of `TSchema` built with `TOptions`. */
export type AuthRelationsFor<TSchema extends Record<string, unknown>, TOptions extends AuthSchemaOptions = {}> =
  ExtractTablesWithRelationsParts<AuthRelationConfig<TOptions>, ExtractTablesFromSchema<TSchema>>

function parseJsonString(value: string): [boolean, unknown] {
  try {
    return [true, JSON.parse(value)]
  }
  catch {
    return [false, value]
  }
}

function decodeSqliteJson(raw: unknown, arrayOnly: boolean): unknown {
  if (raw === null || raw === undefined) return raw
  let value: unknown = raw
  if (typeof value === "string") {
    const [ok, parsed] = parseJsonString(value)
    if (!ok) return value
    value = parsed
  }
  if (typeof value === "string") {
    if (arrayOnly) {
      if (value.startsWith("[")) {
        const [ok, parsed] = parseJsonString(value)
        if (ok && Array.isArray(parsed)) return parsed
      }
    }
    else if (value === "null" || value.startsWith("{") || value.startsWith("[")) {
      const [ok, parsed] = parseJsonString(value)
      if (ok) return parsed
    }
  }
  return value
}

const sqliteJsonArray = customType<{ data: unknown, driverData: string }>({
  dataType: () => "text",
  toDriver: value => JSON.stringify(value),
  fromDriver: value => decodeSqliteJson(value, true),
  fromJson: value => decodeSqliteJson(value, true),
})

const sqliteJsonValue = customType<{ data: unknown, driverData: string }>({
  dataType: () => "text",
  toDriver: value => JSON.stringify(value),
  fromDriver: value => decodeSqliteJson(value, false),
  fromJson: value => decodeSqliteJson(value, false),
})

// SAFETY: Every Drizzle column builder has the chain methods; the casts give the two dialects one builder type.
const sqliteDialect: Dialect<SQLiteColumn, AuthSqliteTable> = {
  column(name, field) {
    const builder = field.type === "boolean"
      ? integer(name, { mode: "boolean" })
      : field.type === "date"
        ? integer(name, { mode: "timestamp_ms" })
        : field.type === "number"
          ? integer(name)
          : field.type === "string"
            ? text(name)
            : field.type === "json"
              ? sqliteJsonValue(name)
              : sqliteJsonArray(name)
    return builder as unknown as ColumnChain<SQLiteColumn>
  },
  id: () => text("id").primaryKey() as unknown as ColumnChain<SQLiteColumn>,
  index: (name, unique, columns) => (unique ? uniqueIndex(name) : index(name)).on(...columns as [SQLiteColumn, ...SQLiteColumn[]]),
  foreignKey: (name, columns, foreignColumns, actions) => sqliteForeignKey({ name, columns: columns as [SQLiteColumn, ...SQLiteColumn[]], foreignColumns: foreignColumns as [SQLiteColumn, ...SQLiteColumn[]] }).onDelete(actions.onDelete).onUpdate(actions.onUpdate),
  now: sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
  nowMs: sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
  raw: sqlText => sql.raw(sqlText),
  // SAFETY: Drizzle builds columns from runtime specs; the shared dialect erases builder types and schema tests verify the resulting tables.
  table: (name, columns, extras) => sqliteTable(name, columns as never, table => extras(table as unknown as Record<string, SQLiteColumn>) as never) as unknown as AuthSqliteTable,
}

const postgresDialect: Dialect<PgColumn, AuthPostgresTable> = {
  column(name, field) {
    const builder = field.type === "boolean"
      ? boolean(name)
      : field.type === "date"
        ? timestamp(name)
        : field.type === "number"
          ? field.bigint ? pgBigint(name, { mode: "number" }) : pgInteger(name)
          : field.type === "string"
            ? pgText(name)
            : field.type === "string[]"
              ? pgText(name).array()
              : field.type === "number[]"
                ? pgInteger(name).array()
                : jsonb(name)
    return builder as unknown as ColumnChain<PgColumn>
  },
  id: () => pgText("id").primaryKey() as unknown as ColumnChain<PgColumn>,
  index: (name, unique, columns) => (unique ? pgUniqueIndex(name) : pgIndex(name)).on(...columns as [PgColumn, ...PgColumn[]]),
  foreignKey: (name, columns, foreignColumns, actions) => pgForeignKey({ name, columns: columns as [PgColumn, ...PgColumn[]], foreignColumns: foreignColumns as [PgColumn, ...PgColumn[]] }).onDelete(actions.onDelete).onUpdate(actions.onUpdate),
  now: sql`now()`,
  nowMs: sql`(extract(epoch from now()) * 1000)::bigint`,
  raw: sqlText => sql.raw(sqlText),
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle builds columns from runtime specs; the shared dialect erases builder types and schema tests verify the resulting tables.
  table: (name, columns, extras) => pgTable(name, columns as never, table => extras(table as unknown as Record<string, PgColumn>) as never) as unknown as AuthPostgresTable,
}

function capitalize(value: string): string {
  return value.length ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value
}

function pluralizeModel(model: string): string {
  return model.endsWith("s") ? model : `${model}s`
}

function buildAuthRelations(
  tables: Record<string, unknown>,
  baseSpecs: Readonly<Record<string, AuthTableSpec>>,
  allSpecs: Readonly<Record<string, AuthTableSpec>> = baseSpecs,
): AnyRelations {
  const schemaTables: Record<string, Table> = {}
  for (const [name, value] of Object.entries(tables)) {
    if (isTable(value)) schemaTables[name] = value
  }
  return defineRelationsPart(schemaTables, (r) => {
    const config: Record<string, RelationsRecord> = {}
    const relationsOf = (model: string): RelationsRecord => {
      config[model] ??= {}
      return config[model]
    }
    const canAdd = (model: string, key: string): boolean => {
      const spec = allSpecs[model]
      if (!spec || key === "id" || Object.hasOwn(spec.fields, key)) return false
      return !Object.hasOwn(relationsOf(model), key)
    }
    for (const [model, baseSpec] of Object.entries(baseSpecs)) {
      if (!Object.hasOwn(schemaTables, model)) continue
      for (const [fieldName, field] of Object.entries(baseSpec.fields)) {
        const reference = field.references
        if (!reference || !Object.hasOwn(schemaTables, reference.model)) continue
        const target = reference.model
        if (canAdd(model, target)) {
          relationsOf(model)[target] = r.one[target]!({
            from: r[model]![fieldName]!,
            to: r[target]![reference.field]!,
          })
        }
        const reverseKey = field.unique ? model : pluralizeModel(model)
        if (canAdd(target, reverseKey)) {
          relationsOf(target)[reverseKey] = field.unique
            ? r.one[model]!({
                from: r[target]![reference.field]!,
                to: r[model]![fieldName]!,
              })
            : r.many[model]!({
                from: r[target]![reference.field]!,
                to: r[model]![fieldName]!,
              })
        }
      }
    }
    for (const [model, spec] of Object.entries(allSpecs)) {
      if (!Object.hasOwn(schemaTables, model)) continue
      const baseFields = baseSpecs[model]?.fields
      for (const [fieldName, field] of Object.entries(spec.fields)) {
        if (baseFields && Object.hasOwn(baseFields, fieldName)) continue
        const reference = field.references
        if (!reference || !Object.hasOwn(schemaTables, reference.model)) continue
        const target = reference.model
        const forwardKey = `${fieldName}${capitalize(target)}`
        if (canAdd(model, forwardKey)) {
          relationsOf(model)[forwardKey] = r.one[target]!({
            from: r[model]![fieldName]!,
            to: r[target]![reference.field]!,
          })
        }
      }
    }
    for (const [model, spec] of Object.entries(allSpecs)) {
      if (!Object.hasOwn(schemaTables, model)) continue
      const baseFields = baseSpecs[model]?.fields
      for (const [fieldName, field] of Object.entries(spec.fields)) {
        if (baseFields && Object.hasOwn(baseFields, fieldName)) continue
        const reference = field.references
        if (!reference || !Object.hasOwn(schemaTables, reference.model)) continue
        const target = reference.model
        const reverseKey = field.unique ? `${model}By${capitalize(fieldName)}` : `${pluralizeModel(model)}By${capitalize(fieldName)}`
        if (canAdd(target, reverseKey)) {
          relationsOf(target)[reverseKey] = field.unique
            ? r.one[model]!({
                from: r[target]![reference.field]!,
                to: r[model]![fieldName]!,
              })
            : r.many[model]!({
                from: r[target]![reference.field]!,
                to: r[model]![fieldName]!,
              })
        }
      }
    }
    for (const [model, modelRelations] of Object.entries(config)) {
      if (!Object.keys(modelRelations).length) delete config[model]
    }
    return config
  })
}

// SAFETY: `buildTables()` builds each table of `authTableSpecs` with the columns that `AuthSqliteSchema` types.
export const authSqliteSchema: AuthSqliteSchema = buildTables(sqliteDialect, authTableSpecs) as unknown as AuthSqliteSchema

// SAFETY: `buildTables()` builds each table of `authTableSpecs` with the columns that `AuthPostgresSchema` types.
export const authPostgresSchema: AuthPostgresSchema = buildTables(postgresDialect, authTableSpecs) as unknown as AuthPostgresSchema

/** Drizzle v1 relations for `authSqliteSchema`. */
export const authSqliteRelations: AuthSqliteRelations = buildAuthRelations(authSqliteSchema, authTableSpecs) as AuthSqliteRelations

/** Drizzle v1 relations for `authPostgresSchema`. */
export const authPostgresRelations: AuthPostgresRelations = buildAuthRelations(authPostgresSchema, authTableSpecs) as AuthPostgresRelations

/**
 * The Better Auth tables for SQLite, libSQL, and Cloudflare D1, with the plugins and additional fields of `options`. The
 * Auth Vite plugin writes a module that calls it when the Auth Definition adds fields or imports a plugin of
 * `AuthSchemaPlugin`, or when the Database has some of the tables already. `existing` holds those tables, read from the
 * latest migration: each one keeps the column defaults, unique keys, and foreign keys that only a table rebuild could
 * change, so the migration adds columns and indexes, and does not drop a table that other tables reference. The
 * columns of the plugins and additional fields are typed from the literal of `options`, with constraints from the
 * snapshot literal when present.
 */
export function createAuthSqliteSchema<const TOptions extends AuthSchemaOptions, const TExisting extends AuthExistingTables | undefined = AuthExistingTables | undefined>(options: TOptions, existing?: TExisting): AuthSqliteSchemaFor<TOptions, TExisting> {
  // SAFETY: `buildTables()` uses the same options and snapshot that determine the table, field, and constraint types.
  return buildTables(sqliteDialect, resolveAuthTableSpecs(options), existing) as unknown as AuthSqliteSchemaFor<TOptions, TExisting>
}

/** The Better Auth tables for Postgres, with the plugins and additional fields of `options`, typed from its literal. */
export function createAuthPostgresSchema<const TOptions extends AuthSchemaOptions>(options: TOptions): AuthPostgresSchemaFor<TOptions> {
  // SAFETY: `resolveAuthTableSpecs()` builds the tables and fields that `AuthPostgresSchemaFor` reads from the same options.
  return buildTables(postgresDialect, resolveAuthTableSpecs(options)) as unknown as AuthPostgresSchemaFor<TOptions>
}

/** Drizzle v1 relations for the Better Auth tables created by `createAuthSqliteSchema()` or `createAuthPostgresSchema()`. */
export function createAuthRelations<TSchema extends Record<string, unknown>, const TOptions extends AuthSchemaOptions = {}>(tables: TSchema, options?: TOptions): AuthRelationsFor<TSchema, TOptions> {
  const baseSpecs = resolveAuthTableSpecs(options?.plugins ? { plugins: options.plugins } : undefined)
  const allSpecs = resolveAuthTableSpecs(options)
  return buildAuthRelations(tables, baseSpecs, allSpecs) as AuthRelationsFor<TSchema, TOptions>
}
