import { expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"

import { defineQueue } from "../src/definition.ts"
import { QueueError, type QueueErrorOptions } from "../src/errors.ts"
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

it("types structured Queue errors", () => {
  const options = {
    code: "INVALID_PAYLOAD",
    details: { field: "email" },
    message: "Invalid payload.",
    retryable: false,
  } satisfies QueueErrorOptions
  const error = new QueueError(options)

  expectTypeOf(error.code).toEqualTypeOf<string>()
  expectTypeOf(error.retryable).toEqualTypeOf<boolean | undefined>()
  expectTypeOf(new QueueError("Provider failed.", { provider: "vercel" })).toEqualTypeOf<QueueError>()
})
