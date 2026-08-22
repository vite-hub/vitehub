import { H3 } from "h3"
import { describe, expect, it } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/index.ts"
import { defineCollectionHandler } from "../src/server.ts"

function createApp() {
  const collection = defineCollection(
    async ({ cursor, limit, query }) => {
      return [{ id: 3 }, { id: 2 }, { id: 1 }]
        .filter(
          (item) =>
            item.id < (cursor ?? Number.POSITIVE_INFINITY) &&
            (!query.minimum || item.id >= query.minimum),
        )
        .slice(0, limit)
    },
    {
      cursor: (item: { id: number }) => item.id,
      cursorSchema: v.number(),
      defaultLimit: 1,
      maxLimit: 2,
      querySchema: v.object({
        minimum: v.optional(v.pipe(v.string(), v.transform(Number), v.number())),
      }),
    },
  )
  return new H3().get("/items", defineCollectionHandler(collection))
}

describe("defineCollectionHandler", () => {
  it("serves bounded pages and forwards typed query input", async () => {
    const app = createApp()
    const firstResponse = await app.request("/items?limit=1&minimum=2")
    const first = (await firstResponse.json()) as {
      items: Array<{ id: number }>
      nextCursor: string
    }

    expect(firstResponse.status).toBe(200)
    expect(first).toMatchObject({ items: [{ id: 3 }], nextCursor: expect.any(String) })

    const secondResponse = await app.request(
      `/items?limit=1&minimum=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    )
    expect(await secondResponse.json()).toEqual({ items: [{ id: 2 }], nextCursor: null })
  })

  it("maps malformed limits, queries, and cursors to client errors", async () => {
    const app = createApp()
    expect((await app.request("/items?limit=0")).status).toBe(400)
    expect((await app.request("/items?minimum=nope")).status).toBe(400)
    expect((await app.request("/items?cursor=invalid")).status).toBe(400)
    expect((await app.request("/items?cursor=")).status).toBe(400)
    expect((await app.request("/items?cursor=one&cursor=two")).status).toBe(400)
  })
})
