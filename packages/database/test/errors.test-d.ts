import { describe, expectTypeOf, it } from "vitest"

import type { ResultError } from "@vite-hub/runtime"

import { databaseErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createAgentDatabase, type AgentDatabaseHandle } from "../src/runtime/agent.ts"

type DatabaseCatalogCode = keyof typeof databaseErrorDiagnostics

describe("Database error types", () => {
  it("keeps one closed set of named codes", () => {
    expectTypeOf<DatabaseCatalogCode>().toEqualTypeOf<
      | "DATABASE_BINDING_CONFLICT"
      | "DATABASE_D1_INVALID_RESPONSE"
      | "DATABASE_D1_REQUEST_FAILED"
      | "DATABASE_DISABLED"
      | "DATABASE_DUPLICATE_DEFINITION"
      | "DATABASE_DUPLICATE_TABLE"
      | "DATABASE_INVALID_CASING"
      | "DATABASE_INVALID_CONTRIBUTION"
      | "DATABASE_INVALID_CONTRIBUTION_TARGET"
      | "DATABASE_INVALID_D1_HTTP_URL"
      | "DATABASE_INVALID_DIALECT"
      | "DATABASE_INVALID_NAME"
      | "DATABASE_INVALID_OPTIONS"
      | "DATABASE_INVALID_SCHEMA_EXPORT"
      | "DATABASE_LAYER_OPTIONS_CONFLICT"
      | "DATABASE_LAYER_TABLE_CONFLICT"
      | "DATABASE_MISSING_CONNECTION"
      | "DATABASE_MISSING_D1_HTTP_CONFIG"
      | "DATABASE_MISSING_D1_RESOURCE"
      | "DATABASE_MIXED_DEFINITIONS"
      | "DATABASE_NAME_MISMATCH"
      | "DATABASE_NOT_FOUND"
      | "DATABASE_OPAQUE_CLOUDFLARE_CONFIG"
      | "DATABASE_PROVISION_FAILED"
      | "DATABASE_RESERVED_SCHEMA_KEY"
      | "DATABASE_SCHEMA_LOAD_FAILED"
      | "DATABASE_UNKNOWN_OPTION"
    >()
  })

  it("types each error with its code", () => {
    expectTypeOf(databaseErrorDiagnostics.DATABASE_NOT_FOUND).returns.toEqualTypeOf<ResultError<"DATABASE_NOT_FOUND">>()
    expectTypeOf(databaseErrorDiagnostics.DATABASE_NOT_FOUND).parameter(0).toMatchTypeOf<{ database: string }>()
  })

  it("keeps the raw SQL handle of the Agent capability as a plain promise", () => {
    // The Agent capability owns the handle contract: `query()` and `exec()` resolve with rows and throw on failure.
    const agentDb = createAgentDatabase({})
    expectTypeOf(agentDb.query).returns.toEqualTypeOf<Promise<unknown>>()
    expectTypeOf(agentDb.database).returns.toEqualTypeOf<AgentDatabaseHandle>()
  })
})
