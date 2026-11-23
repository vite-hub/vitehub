import { vi } from "vitest"

import { followFakeClockClient } from "./state-database-clock.ts"

vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>()
  return { ...actual, createClient: followFakeClockClient(actual.createClient) }
})
