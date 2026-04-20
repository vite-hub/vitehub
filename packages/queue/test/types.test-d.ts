import { expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"

import { defineQueue } from "../src/definition.ts"
import { hubQueue } from "../src/vite.ts"

it("returns a vite plugin", () => {
  expectTypeOf(hubQueue()).toMatchTypeOf<Plugin>()
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
