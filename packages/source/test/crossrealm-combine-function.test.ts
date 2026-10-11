import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { combineSources } from "../src/index.ts"

describe("combined Sources cross realm functions", () => {
  it("enumerates a reader whose items method comes from another realm", async () => {
    const items = runInNewContext("async () => [{ key: 'foreign' }]") as () => Promise<Array<{ key: string }>>
    const source = {
      get: async (key: string) => key,
      items,
    }
    const combined = combineSources({ sources: { foreign: source } })
    expect(combined).toHaveProperty("items")
    await expect(combined.items!()).resolves.toEqual([{ identity: ["foreign", "foreign"], key: "foreign", source: "foreign" }])
  })
})
