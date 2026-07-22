import { expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"

import { defineQueue } from "../src/definition.ts"
import type { QueueErrorCode } from "../src/errors.ts"
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

it("types Queue error codes", () => {
  expectTypeOf<QueueErrorCode>().toEqualTypeOf<
    | "CLOUDFLARE_BINDING_INVALID"
    | "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED"
    | "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS"
    | "QUEUE_DEFINITION_LOAD_FAILED"
    | "QUEUE_DEFINITION_NOT_FOUND"
    | "QUEUE_DISABLED"
    | "QUEUE_PROVIDER_OPERATION_FAILED"
    | "QUEUE_PROVIDER_RESPONSE_INVALID"
    | "VERCEL_PROVIDER_EXPECTED"
    | "VERCEL_QUEUE_REGION_REQUIRED"
    | "VERCEL_QUEUE_SDK_INVALID"
    | "VERCEL_QUEUE_SDK_LOAD_FAILED"
    | "VERCEL_TOPIC_RESOLUTION_REQUIRED"
    | "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS"
  >()

})
