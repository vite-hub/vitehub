import { expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"

import { defineQueue } from "../src/definition.ts"
import { deferQueue, runQueue } from "../src/runtime/client.ts"
import { hubQueue } from "../src/vite.ts"

it("returns a vite plugin", () => {
  expectTypeOf(hubQueue()).toMatchTypeOf<Plugin>()
  expectTypeOf(hubQueue({ provider: "cloudflare" })).toMatchTypeOf<Plugin>()
})

it("infers queue payload types", () => {
  const queue = defineQueue<{ email: string }>(async (job) => job.payload.email)
  expectTypeOf(queue.handler).parameters.toEqualTypeOf<[{
    attempts: number
    id: string
    metadata?: unknown
    payload: { email: string }
  }]>()
})

it("types Queue Enqueue payloads separately from options", () => {
  expectTypeOf(runQueue("welcome", { payload: "value" })).toEqualTypeOf<Promise<{ messageId?: string, status: "queued" }>>()
  expectTypeOf(runQueue("welcome", { email: "ava@example.com" }, { delaySeconds: 60 })).toEqualTypeOf<Promise<{ messageId?: string, status: "queued" }>>()
  expectTypeOf(deferQueue("welcome", { payload: "value" }, { id: "message-1" })).toEqualTypeOf<void>()
})
