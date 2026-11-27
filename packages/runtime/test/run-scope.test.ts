import { expect, it } from "vitest"

import { registerRunScope, runInRunScopes } from "../src/internal/run-scope.ts"

it("runs a unit of work inside each registered scope and passes on its result and error", async () => {
  const events: string[] = []
  const scope = (name: string) => async (run: () => Promise<void>) => {
    events.push(`enter ${name}`)
    try {
      await run()
    }
    catch (error) {
      events.push(`failed ${name}`)
      throw error
    }
  }
  const outer = scope("workspace")
  registerRunScope(outer)
  registerRunScope(outer)
  registerRunScope(scope("trace"))

  await expect(runInRunScopes(() => 42)).resolves.toBe(42)
  await expect(runInRunScopes(async () => { throw new Error("SMTP down") })).rejects.toThrow("SMTP down")
  expect(events).toEqual([
    "enter trace", "enter workspace",
    "enter trace", "enter workspace", "failed workspace", "failed trace",
  ])
})
