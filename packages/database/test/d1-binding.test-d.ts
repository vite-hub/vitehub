import { describe, expectTypeOf, it } from "vitest"

import type { useDatabaseBinding as usePublishedDatabaseBinding } from "@vite-hub/database/drizzle"
import type { useDatabaseBinding } from "../src/drizzle.ts"
import type { DatabaseD1Binding } from "../src/runtime/agent.ts"

describe("D1 binding and session types", () => {
  it("exposes only operations available on request sessions", () => {
    expectTypeOf<typeof useDatabaseBinding>().returns.toEqualTypeOf<DatabaseD1Binding>()
    expectTypeOf<typeof usePublishedDatabaseBinding>().returns.toEqualTypeOf<DatabaseD1Binding>()
    expectTypeOf<DatabaseD1Binding["prepare"]>().toBeFunction()
    expectTypeOf<DatabaseD1Binding["batch"]>().toBeFunction()
    expectTypeOf<DatabaseD1Binding>().not.toHaveProperty("exec")
    expectTypeOf<DatabaseD1Binding>().not.toHaveProperty("withSession")
    expectTypeOf<DatabaseD1Binding>().not.toHaveProperty("dump")
  })
})
