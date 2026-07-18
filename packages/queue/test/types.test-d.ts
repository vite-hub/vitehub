import { expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"

import { defineQueue } from "../src/definition.ts"
import { QueueError, type QueueErrorCode, type QueueErrorMetadata, type QueueErrorOptions } from "../src/errors.ts"
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
    httpStatus: 422,
    message: "Invalid payload.",
    retryable: false,
  } satisfies QueueErrorOptions<"INVALID_PAYLOAD">
  const error = new QueueError<"INVALID_PAYLOAD">(options)
  const metadata = {
    code: "INVALID_PAYLOAD",
    details: { field: "email" },
    httpStatus: 422,
    retryable: false,
  } satisfies QueueErrorMetadata
  const compatibleError = new QueueError("Invalid payload.", metadata)

  expectTypeOf(error.code).toEqualTypeOf<"INVALID_PAYLOAD">()
  expectTypeOf(error.httpStatus).toEqualTypeOf<number | undefined>()
  expectTypeOf(compatibleError.httpStatus).toEqualTypeOf<number | undefined>()
  expectTypeOf(error.retryable).toEqualTypeOf<boolean | undefined>()
  expectTypeOf<QueueErrorCode>().toEqualTypeOf<
    | "CLOUDFLARE_BINDING_INVALID"
    | "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED"
    | "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS"
    | "QUEUE_DEFINITION_LOAD_FAILED"
    | "QUEUE_DEFINITION_NOT_FOUND"
    | "QUEUE_DISABLED"
    | "QUEUE_PROVIDER_OPERATION_FAILED"
    | "VERCEL_PROVIDER_EXPECTED"
    | "VERCEL_QUEUE_REGION_REQUIRED"
    | "VERCEL_QUEUE_SDK_INVALID"
    | "VERCEL_QUEUE_SDK_LOAD_FAILED"
    | "VERCEL_TOPIC_RESOLUTION_REQUIRED"
    | "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS"
  >()

  // @ts-expect-error Custom codes require an explicit QueueError generic.
  new QueueError({ code: "INVALID_PAYLOAD", message: "Invalid payload." })
  // @ts-expect-error Built-in provider operations use the observed operation union.
  new QueueError({
    code: "QUEUE_PROVIDER_OPERATION_FAILED",
    details: { operation: "cancel", provider: "vercel" },
    message: "Provider failed.",
  })
  // @ts-expect-error QUEUE_DISABLED does not publish arbitrary details.
  new QueueError({ code: "QUEUE_DISABLED", details: { queue: "private" }, message: "Queue is disabled." })
  new QueueError("Provider failed.", { httpStatus: 503, retryable: true })
})
