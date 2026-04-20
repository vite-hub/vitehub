import { describe, expect, it } from "vitest"

import { normalizeQueueEnqueueInput } from "../src/enqueue.ts"

describe("normalizeQueueEnqueueInput", () => {
  it("treats payload-only objects as enqueue envelopes", () => {
    const normalized = normalizeQueueEnqueueInput({
      payload: { email: "ava@example.com" },
    })

    expect(normalized.options).toEqual({})
    expect(normalized.payload).toEqual({ email: "ava@example.com" })
    expect(normalized.id).toMatch(/^queue_/)
  })

  it("keeps raw payload objects without a payload key unchanged", () => {
    const normalized = normalizeQueueEnqueueInput({
      email: "ava@example.com",
    })

    expect(normalized.options).toEqual({})
    expect(normalized.payload).toEqual({ email: "ava@example.com" })
    expect(normalized.id).toMatch(/^queue_/)
  })
})
