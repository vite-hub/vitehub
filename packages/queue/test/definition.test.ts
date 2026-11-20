import { describe, expect, it } from "vitest"

import { defineQueue } from "../src/definition.ts"

describe("defineQueue", () => {
  it("returns the handler and options as one object", () => {
    const handler = async ({ payload }: { payload: { email: string } }) => payload.email
    expect(defineQueue({ handler, concurrency: 2 })).toEqual({ handler, concurrency: 2 })
  })

  it.each([
    ["the removed handler argument", [async () => {}], "`defineQueue(handler, options)` was removed."],
    ["the removed options argument", [{ handler: async () => {} }, { concurrency: 2 }], "`defineQueue(handler, options)` was removed."],
    ["no object", [undefined], "`defineQueue()` expects one object with `handler`."],
    ["no handler", [{ concurrency: 2 }], "`defineQueue()` needs a `handler` function."],
    ["an unknown option", [{ handler: async () => {}, retries: 3 }], "`defineQueue()` does not support the \"retries\" option."],
  ])("rejects %s with QUEUE_INVALID_DEFINITION", (_, args, message) => {
    // @ts-expect-error The test passes the removed and invalid forms.
    expect(() => defineQueue(...args)).toThrow(expect.objectContaining({ code: "QUEUE_INVALID_DEFINITION", message: expect.stringContaining(message) }))
  })

  it.each([0, 101, 2.5, Number.NaN])("rejects maxBatchSize %s with QUEUE_MAX_BATCH_SIZE_INVALID", (maxBatchSize) => {
    expect(() => defineQueue({ handler: async () => {}, maxBatchSize })).toThrow(expect.objectContaining({ code: "QUEUE_MAX_BATCH_SIZE_INVALID" }))
  })
})
