import { describe, expectTypeOf, it } from "vitest"

import type { ResultError } from "@vite-hub/runtime"

import { databaseErrorDiagnostics } from "../src/error-diagnostics.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { createAgentDatabase, type AgentDatabaseHandle } from "../src/runtime/agent.ts"

type DatabaseCatalogCode = keyof typeof databaseErrorDiagnostics

describe("Database error types", () => {
  it("keeps one closed set of named codes", () => {
    expectTypeOf<DatabaseCatalogCode>().toEqualTypeOf<
      | "DATABASE_BINDING_CONFLICT"
      | "DATABASE_D1_INVALID_RESPONSE"
      | "DATABASE_D1_MIGRATION_INVALID"
      | "DATABASE_D1_REQUEST_FAILED"
      | "DATABASE_D1_STATEMENT_TOO_LONG"
      | "DATABASE_D1_TOO_MANY_PARAMETERS"
      | "DATABASE_D1_VALUE_TOO_LARGE"
      | "DATABASE_DISABLED"
      | "DATABASE_DRIZZLE_OPTION_REMOVED"
      | "DATABASE_DUPLICATE_DEFINITION"
      | "DATABASE_DUPLICATE_TABLE"
      | "DATABASE_EXPORT_FAILED"
      | "DATABASE_INVALID_CONTRIBUTION"
      | "DATABASE_INVALID_CONTRIBUTION_TARGET"
      | "DATABASE_INVALID_D1_HTTP_URL"
      | "DATABASE_INVALID_DIALECT"
      | "DATABASE_INVALID_NAME"
      | "DATABASE_INVALID_OPTIONS"
      | "DATABASE_INVALID_RELATIONS"
      | "DATABASE_INVALID_REMOTE"
      | "DATABASE_INVALID_SCHEMA_EXPORT"
      | "DATABASE_LAYER_OPTIONS_CONFLICT"
      | "DATABASE_LAYER_TABLE_CONFLICT"
      | "DATABASE_LEGACY_CONFIG_FILE"
      | "DATABASE_MIGRATE_ON_START_UNSUPPORTED"
      | "DATABASE_MIGRATION_CHECK_FAILED"
      | "DATABASE_MIGRATION_DATA_LOSS"
      | "DATABASE_MIGRATION_FAILED"
      | "DATABASE_MIGRATIONS_OLD_LAYOUT"
      | "DATABASE_MISSING_CONNECTION"
      | "DATABASE_MISSING_D1_HTTP_CONFIG"
      | "DATABASE_MISSING_D1_RESOURCE"
      | "DATABASE_MIXED_DEFINITIONS"
      | "DATABASE_NAME_MISMATCH"
      | "DATABASE_NAME_REQUIRED"
      | "DATABASE_NO_D1_BINDING"
      | "DATABASE_NOT_CONNECTED"
      | "DATABASE_NOT_FOUND"
      | "DATABASE_OPAQUE_CLOUDFLARE_CONFIG"
      | "DATABASE_PROVISION_FAILED"
      | "DATABASE_REMOTE_CONFLICT"
      | "DATABASE_RESERVED_SCHEMA_KEY"
      | "DATABASE_SCHEMA_LOAD_FAILED"
      | "DATABASE_UNKNOWN_OPTION"
      | "DATABASE_UNSUPPORTED_URL"
      | "DATABASE_WRANGLER_BINDING_CONFLICT"
    >()
  })

  it("types each error with its code", () => {
    expectTypeOf(databaseErrorDiagnostics.DATABASE_NOT_FOUND).returns.toEqualTypeOf<ResultError<"DATABASE_NOT_FOUND", undefined>>()
    expectTypeOf(databaseErrorDiagnostics.DATABASE_NOT_FOUND).parameter(0).toMatchTypeOf<{ database: string }>()
  })

  it("returns only the migration check error from readMigrationPlan", () => {
    expectTypeOf<Awaited<ReturnType<typeof readMigrationPlan>>[0]>().toEqualTypeOf<ResultError<"DATABASE_MIGRATION_CHECK_FAILED"> | undefined>()
  })

  it("keeps the raw SQL handle of the Agent capability as a plain promise", () => {
    // The Agent capability owns the handle contract: `query()` and `exec()` resolve with rows and throw on failure.
    const agentDb = createAgentDatabase({})
    expectTypeOf(agentDb.query).returns.toEqualTypeOf<Promise<unknown>>()
    expectTypeOf(agentDb.database).returns.toEqualTypeOf<AgentDatabaseHandle>()
  })
})
