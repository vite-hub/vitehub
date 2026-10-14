import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { defineCollection } from "../src/source.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"

describe("ViteHub Source collection adapter", () => {
  it("accepts a loader function from another realm", async () => {
    const loader = runInNewContext("async ({ limit }) => [{ id: limit }]") as (options: { limit: number }) => Promise<Array<{ id: number }>>
    const cursorSchema: StandardSchemaV1<number, number> = {
      "~standard": {
        version: 1,
        vendor: "vite-hub",
        validate: (value: unknown) => ({ value: value as number }),
      },
    }
    const collection = defineCollection(loader, {
      cursor: (item: { id: number }) => item.id,
      cursorSchema,
      defaultLimit: 3,
    })
    await expect(collection.page({ query: {}, signal: new AbortController().signal })).resolves.toEqual({ items: [{ id: 4 }], nextCursor: null })
  })
})
