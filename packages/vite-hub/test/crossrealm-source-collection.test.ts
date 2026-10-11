import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { defineCollection } from "../src/source.ts"

describe("ViteHub Source collection adapter", () => {
  it("accepts a loader function from another realm", async () => {
    const loader = runInNewContext("async ({ limit }) => [{ id: limit }]") as (options: { limit: number }) => Promise<Array<{ id: number }>>
    const collection = defineCollection(loader, {
      cursorSchema: {
        "~standard": {
          version: 1,
          vendor: "vite-hub",
          validate: (value: unknown) => ({ value }),
        },
      },
      defaultLimit: 3,
    })
    await expect(collection.page({ query: {}, signal: new AbortController().signal })).resolves.toEqual({ items: [{ id: 4 }], nextCursor: null })
  })
})
