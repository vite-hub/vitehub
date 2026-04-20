import { expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"

import { createQueue, defineQueue } from "../src/definition.ts"
import { hubQueue } from "../src/vite.ts"

it("returns a vite plugin", () => {
  expectTypeOf(hubQueue()).toMatchTypeOf<Plugin>()
})

it("infers queue payload types", () => {
  const queue = defineQueue<{ email: string }>(async (job) => job.payload.email)
  const created = createQueue({
    handler: async (job: { payload: { email: string } }) => job.payload.email,
  })

  expectTypeOf(queue.handler).parameters.toEqualTypeOf<[{
    attempts: number
    id: string
    metadata?: unknown
    payload: { email: string }
  }]>()
  expectTypeOf(created.handler).toEqualTypeOf<(job: {
    attempts: number
    id: string
    metadata?: unknown
    payload: { email: string }
  }) => Promise<string>>()
})
