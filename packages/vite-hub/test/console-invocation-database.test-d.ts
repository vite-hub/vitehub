import { expectTypeOf, it } from "vitest"

import type { AgentInvocationSummary } from "@vite-hub/agent"
import type { ConsoleInvocationsDatabase } from "../src/console/runtime/server/invocations.ts"

it("requires D1 derived insert columns and preserves nullable libSQL reads", () => {
  type D1 = Extract<ConsoleInvocationsDatabase, { driver: "d1" }>
  type Libsql = Extract<ConsoleInvocationsDatabase, { driver: "libsql" }>
  type Insert = D1["schema"]["invocations"]["$inferInsert"]
  const record = {
    id: "invocation", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z",
    status: "completed" as const, traceId: "trace", observations: [],
  }
  const required = { id: record.id, status: record.status, record }
  const valid = { ...required, search: "", summary: record } satisfies Insert
  expectTypeOf(valid).toExtend<Insert>()
  // @ts-expect-error D1 requires search without a SQL default.
  const missingSearch: Insert = { ...required, summary: record }
  // @ts-expect-error D1 requires summary without a SQL default.
  const missingSummary: Insert = { ...required, search: "" }
  // @ts-expect-error D1 search cannot be null.
  const nullSearch: Insert = { ...valid, search: null }
  // @ts-expect-error D1 summary cannot be null.
  const nullSummary: Insert = { ...valid, summary: null }
  void [missingSearch, missingSummary, nullSearch, nullSummary]

  expectTypeOf<Libsql["schema"]["invocations"]["$inferSelect"]["search"]>().toEqualTypeOf<string | null>()
  expectTypeOf<Libsql["schema"]["invocations"]["$inferSelect"]["summary"]>().toEqualTypeOf<Omit<AgentInvocationSummary, "cursor"> | null>()
})
