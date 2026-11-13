import { H3 } from "h3"
import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/index.ts"
import { defineCollectionHandler } from "../src/server.ts"

import type { AccessAuthorizeOption } from "@vite-hub/runtime"
import type { CollectionAuthorizationGuard } from "../src/server.ts"

function createApp() {
  const collection = defineCollection(
    async ({ cursor, limit, query }) => {
      return [{ id: 3 }, { id: 2 }, { id: 1 }]
        .filter(item => item.id < (cursor ?? Number.POSITIVE_INFINITY) && (!query.minimum || item.id >= query.minimum))
        .slice(0, limit)
    },
    {
      authorize: false,
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

class NonPlainItem {
  get id() {
    return 1
  }
}

describe("defineCollectionHandler", () => {
  describe("route access", () => {
    const load = async () => [{ id: 1 }]

    it("requires authorize on a routed Collection", () => {
      // @ts-expect-error A routed Collection must set authorize or route: false.
      expect(() => defineCollection(load, { cursor: item => item.id, cursorSchema: v.number() }))
        .toThrow(expect.objectContaining({ code: "SOURCE_R0035" }))
    })

    it("fails closed for a Collection object without authorize", () => {
      const collection = defineCollection(load, { cursor: item => item.id, cursorSchema: v.number(), route: false })
      const { route: _route, ...routed } = collection
      expect(() => defineCollectionHandler(routed)).toThrow(expect.objectContaining({ code: "SOURCE_R0035" }))
    })

    it("serves authorize: false without Auth", async () => {
      const collection = defineCollection(load, { authorize: false, cursor: item => item.id, cursorSchema: v.number() })

      const response = await defineCollectionHandler(collection).fetch(new Request("https://app.test/items"))

      expect(collection.authorize).toBe(false)
      expect(await response.json()).toEqual({ items: [{ id: 1 }], nextCursor: null })
    })

    it("allows a server-only Collection without authorize", async () => {
      const collection = defineCollection(load, { cursor: item => item.id, cursorSchema: v.number(), route: false })
      expect(collection.authorize).toBeUndefined()
      expect((await collection.page({ query: {} })).items).toEqual([{ id: 1 }])
    })
  })

  describe("authorize", () => {
    function privateCollection(authorize: AccessAuthorizeOption, load = vi.fn(async () => [{ id: 1 }])) {
      return {
        collection: defineCollection(load, { authorize, cursor: item => item.id, cursorSchema: v.number() }),
        load,
      }
    }

    // Mirrors Auth's withAuthorization contract: the Auth package tests the real session lookup.
    const withAuthorization: CollectionAuthorizationGuard = (authorize, handler) => async (request) => {
      const user = request.headers.get("cookie") === "session=u1" ? { id: "u1" } : undefined
      if (!user) return Response.json({ error: "Unauthorized." }, { status: 401 })
      const result = authorize === true || await authorize({ request, session: {}, user })
      if (result instanceof Response) return result
      if (result !== true) return Response.json({ error: "Forbidden." }, { status: 403 })
      return handler(request)
    }

    it("fails closed when the route has no Auth authorizer", () => {
      const { collection } = privateCollection(true)
      expect(() => defineCollectionHandler(collection)).toThrow("Collection authorize requires Auth")
    })

    it("returns 401 before parsing the query or loading rows", async () => {
      const { collection, load } = privateCollection(true)
      const app = new H3().get("/meals", defineCollectionHandler(collection, { withAuthorization }))

      const response = await app.request("/meals?limit=invalid")

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: "Unauthorized." })
      expect(load).not.toHaveBeenCalled()
    })

    it("returns 403 when authorize returns false and a custom response as-is", async () => {
      const denied = privateCollection(() => false)
      const deniedApp = new H3().get("/meals", defineCollectionHandler(denied.collection, { withAuthorization }))
      const forbidden = await deniedApp.request("/meals", { headers: { cookie: "session=u1" } })
      expect(forbidden.status).toBe(403)
      expect(denied.load).not.toHaveBeenCalled()

      const custom = privateCollection(() => new Response("Upgrade required", { status: 402 }))
      const customApp = new H3().get("/meals", defineCollectionHandler(custom.collection, { withAuthorization }))
      const payment = await customApp.request("/meals", { headers: { cookie: "session=u1" } })
      expect(payment.status).toBe(402)
      expect(await payment.text()).toBe("Upgrade required")
    })

    it("serves the page after authorization", async () => {
      const { collection } = privateCollection(({ user }) => user.id === "u1")
      const app = new H3().get("/meals", defineCollectionHandler(collection, { withAuthorization }))

      const response = await app.request("/meals", { headers: { cookie: "session=u1" } })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ items: [{ id: 1 }], nextCursor: null })
    })

    it("keeps public Collections public when an authorizer is present", async () => {
      const collection = defineCollection(async () => [{ id: 1 }], { authorize: false, cursor: item => item.id, cursorSchema: v.number() })
      const authorizer = vi.fn()
      const guard: CollectionAuthorizationGuard = (authorize, handler) => {
        authorizer()
        return withAuthorization(authorize, handler)
      }
      const response = await new H3().get("/meals", defineCollectionHandler(collection, { withAuthorization: guard })).request("/meals")

      expect(response.status).toBe(200)
      expect(authorizer).not.toHaveBeenCalled()
    })
  })

  it("rejects a non-Collection before accepting requests", () => {
    // SAFETY: The test deliberately violates the input contract to prove the runtime guard.
    expect(() => defineCollectionHandler({} as never)).toThrow("defineCollectionHandler() requires a Collection")
  })

  it("rejects Collection methods inherited from an ordinary object", () => {
    const collection = Object.create({
      page: async () => ({ items: [], nextCursor: null }),
      parseQuery: async () => ({}),
    })

    expect(() => defineCollectionHandler(collection as never)).toThrow("defineCollectionHandler() requires a Collection")
  })

  it("rejects inherited Collection methods with a forged constructor", () => {
    const collection = Object.create({
      constructor: function Fake() {},
      page: async () => ({ items: [], nextCursor: null }),
      parseQuery: async () => ({}),
    })

    expect(() => defineCollectionHandler(collection as never)).toThrow("defineCollectionHandler() requires a Collection")
  })

  it("accepts Collection methods declared on a class prototype", () => {
    class CollectionLike {
      readonly authorize = false

      async page() {
        return { items: [], nextCursor: null }
      }

      async parseQuery() {
        return {}
      }
    }

    expect(() => defineCollectionHandler(new CollectionLike() as never)).not.toThrow()
  })

  it("serves bounded pages and forwards typed query input", async () => {
    const app = createApp()
    const firstResponse = await app.request("/items?limit=1&minimum=2")
    const first: unknown = await firstResponse.json()

    expect(firstResponse.status).toBe(200)
    expect(first).toMatchObject({ items: [{ id: 3 }], nextCursor: expect.any(String) })
    if (Object(first) !== first) throw new TypeError("Expected a Collection page.")
    const nextCursor = Reflect.get(Object(first), "nextCursor")
    if (String(nextCursor) !== nextCursor) throw new TypeError("Expected a cursor.")

    const secondResponse = await app.request(`/items?limit=1&minimum=2&cursor=${encodeURIComponent(nextCursor)}`)
    expect(await secondResponse.json()).toEqual({ items: [{ id: 2 }], nextCursor: null })
  })

  it.each([
    ["/filters", {}],
    ["/filters?tags=one", { tags: "one" }],
    ["/filters?tags=one&tags=two", { tags: ["one", "two"] }],
  ])("accepts raw query cardinality from %s", async (path, expectedQuery) => {
    let receivedQuery: unknown
    const collection = defineCollection(
      async ({ query }) => {
        receivedQuery = query
        return []
      },
      {
        authorize: false,
        cursor: () => "done",
        cursorSchema: v.string(),
        querySchema: v.object({ tags: v.optional(v.union([v.string(), v.array(v.string())])) }),
      },
    )

    const response = await new H3().get("/filters", defineCollectionHandler(collection)).request(path)

    expect(response.status).toBe(200)
    expect(receivedQuery).toEqual(expectedQuery)
  })

  it("serializes Collection items before clients consume them", async () => {
    const collection = defineCollection(
      async () => [
        {
          at: new Date("2026-08-22T00:00:00.000Z"),
          custom: { toJSON: () => ({ id: "custom" }) },
          url: new URL("https://vitehub.dev/collections"),
        },
      ],
      {
        authorize: false,
        cursor: item => item.at.toISOString(),
        cursorSchema: v.string(),
      },
    )
    const response = await new H3().get("/events", defineCollectionHandler(collection)).request("/events")

    expect(await response.json()).toEqual({
      items: [
        {
          at: "2026-08-22T00:00:00.000Z",
          custom: { id: "custom" },
          url: "https://vitehub.dev/collections",
        },
      ],
      nextCursor: null,
    })
  })

  it("matches JSON coercion and omission at the Collection boundary", async () => {
    const collection = defineCollection(
      async () => {
        const optional: string | undefined = undefined
        return [
          {
            array: [
              undefined,
              Number.NaN,
              Number.POSITIVE_INFINITY,
              () => undefined,
              Symbol("x"),
              { toJSON: () => undefined },
            ],
            omitted: undefined,
            optional,
            toJSONOmitted: { toJSON: () => undefined },
            value: Number.NEGATIVE_INFINITY,
          },
        ]
      },
      {
        authorize: false,
        cursor: () => "done",
        cursorSchema: v.string(),
      },
    )
    const response = await new H3().get("/values", defineCollectionHandler(collection)).request("/values")

    expect(await response.json()).toEqual({
      items: [{ array: [null, null, null, null, null, null], value: null }],
      nextCursor: null,
    })
  })

  it("coerces an item whose toJSON returns undefined to null", async () => {
    const collection = defineCollection(async () => [{ toJSON: () => undefined }], {
      authorize: false,
      cursor: () => "done",
      cursorSchema: v.string(),
    })
    const response = await new H3().get("/values", defineCollectionHandler(collection)).request("/values")

    expect(await response.json()).toEqual({ items: [null], nextCursor: null })
  })

  it("applies toJSON once to each serialized property", async () => {
    const rejected = defineCollection(async () => [{ toJSON: () => new Date("2026-08-22T00:00:00.000Z") }], {
      authorize: false,
      cursor: () => "done",
      cursorSchema: v.string(),
    })
    const accepted = defineCollection(
      async () => [{ toJSON: () => ({ nested: new Date("2026-08-22T00:00:00.000Z") }) }],
      {
        authorize: false,
        cursor: () => "done",
        cursorSchema: v.string(),
      },
    )

    const rejectedResponse = await new H3().get("/rejected", defineCollectionHandler(rejected)).request("/rejected")
    const acceptedResponse = await new H3().get("/accepted", defineCollectionHandler(accepted)).request("/accepted")

    expect(rejectedResponse.status).toBe(500)
    expect(acceptedResponse.status).toBe(200)
    expect(await acceptedResponse.json()).toEqual({
      items: [{ nested: "2026-08-22T00:00:00.000Z" }],
      nextCursor: null,
    })
  })

  it("rejects Collection pages containing bigint", async () => {
    const collection = defineCollection(async () => [{ id: 1n }], {
      authorize: false,
      cursor: () => "done",
      cursorSchema: v.string(),
    })
    const app = new H3().get("/bigints", defineCollectionHandler(collection))

    const response = await app.request("/bigints")
    expect(response.status).toBe(500)
  })

  it("serializes only the supported active branches of item unions", async () => {
    let value: bigint | string = "one"
    const collection = defineCollection(async () => [{ array: [value], nested: { value }, value }], {
      authorize: false,
      cursor: () => "done",
      cursorSchema: v.string(),
    })
    const app = new H3().get("/unions", defineCollectionHandler(collection))

    const supported = await app.request("/unions")
    expect(supported.status).toBe(200)
    expect(await supported.json()).toEqual({
      items: [{ array: ["one"], nested: { value: "one" }, value: "one" }],
      nextCursor: null,
    })

    value = 1n
    const unsupported = await app.request("/unions")
    expect(unsupported.status).toBe(500)
  })

  it.each([
    new ArrayBuffer(1),
    new DataView(new ArrayBuffer(1)),
    new Map([["id", 1]]),
    new Set([1]),
    new SharedArrayBuffer(1),
    new Uint8Array([1]),
    new WeakMap([[{}, 1]]),
    new WeakSet([{}]),
    /collection/,
    new Error("collection"),
    new NonPlainItem(),
  ])("rejects non-plain Collection item objects", async item => {
    const collection = defineCollection(async () => [item], {
      authorize: false,
      cursor: () => "done",
      cursorSchema: v.string(),
    })
    const response = await new H3().get("/objects", defineCollectionHandler(collection)).request("/objects")

    expect(response.status).toBe(500)
  })

  it("answers 404 for a Collection with route: false and does not read it", async () => {
    const load = vi.fn(async () => [{ id: 1 }])
    const collection = defineCollection(load, {
      authorize: true,
      cursor: (item: { id: number }) => item.id,
      cursorSchema: v.number(),
      querySchema: v.object({}),
      route: false,
    })
    const handler = defineCollectionHandler(collection)

    const response = await handler.fetch(new Request("http://example.test/api/articles"))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ status: 404, message: "Not Found" })
    expect(load).not.toHaveBeenCalled()
  })

  it("answers a Web Request as a Fetchable, with JSON error Responses", async () => {
    const collection = defineCollection(
      async ({ limit, query }) => [{ id: 3 }, { id: 2 }, { id: 1 }].filter(item => !query.minimum || item.id >= Number(query.minimum)).slice(0, limit),
      { authorize: false, cursor: (item: { id: number }) => item.id, cursorSchema: v.number(), querySchema: v.object({ minimum: v.optional(v.string()) }) },
    )
    const handler = defineCollectionHandler(collection)

    const page = await handler.fetch(new Request("http://example.test/base/items?limit=1&minimum=2"))
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toBe("application/json")
    await expect(page.json()).resolves.toEqual({ items: [{ id: 3 }], nextCursor: "Mw" })

    const invalid = await handler.fetch(new Request("http://example.test/items?limit=1&limit=2"))
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toEqual({ status: 400, message: "[vitehub] Collection query parameter \"limit\" must have one value." })
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
