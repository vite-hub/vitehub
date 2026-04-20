import { expectTypeOf, it } from "vitest"
import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"

import { defineQueue } from "../src/definition.ts"
import queueNitroModule from "../src/nitro.ts"
import { hubQueue } from "../src/vite.ts"

it("returns a vite plugin", () => {
  expectTypeOf(hubQueue()).toMatchTypeOf<Plugin>()
})

it("exposes a Nitro module surface", () => {
  expectTypeOf(hubQueue().nitro).toMatchTypeOf<NitroModule>()
  expectTypeOf(queueNitroModule).toMatchTypeOf<NitroModule>()
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
