import { expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"

import { deferQueue, dynamicQueue, getQueue, runQueue } from "../src/runtime/client.ts"
import { defineQueue } from "../src/definition.ts"
import type { Result } from "@vite-hub/runtime"
import type { CloudflareQueueClient, CloudflareQueueErrorCode, QueueErrorCode, QueueSendResult, VercelQueueClient, VercelQueueErrorCode } from "../src/index.ts"
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
    | "QUEUE_PROVIDER_FAILED"
    | "QUEUE_PROVIDER_INVALID_RESPONSE"
    | "QUEUE_UNSUPPORTED_OPTION"
  >()
  expectTypeOf<CloudflareQueueErrorCode>().toEqualTypeOf<"QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION">()
  expectTypeOf<VercelQueueErrorCode>().toEqualTypeOf<QueueErrorCode>()
})

it("types the codes of each method", () => {
  expectTypeOf(runQueue<"welcome">).returns.toEqualTypeOf<Promise<Result<QueueSendResult, QueueErrorCode>>>()
  expectTypeOf(dynamicQueue.run).returns.toEqualTypeOf<Promise<Result<QueueSendResult, QueueErrorCode>>>()
  expectTypeOf<CloudflareQueueClient["send"]>().returns.toEqualTypeOf<Promise<Result<QueueSendResult, "QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION">>>()
  expectTypeOf<CloudflareQueueClient["sendBatch"]>().returns.toEqualTypeOf<Promise<Result<QueueSendResult[], "QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION">>>()
  expectTypeOf<VercelQueueClient["send"]>().returns.toEqualTypeOf<Promise<Result<QueueSendResult, "QUEUE_PROVIDER_FAILED" | "QUEUE_PROVIDER_INVALID_RESPONSE" | "QUEUE_UNSUPPORTED_OPTION">>>()
  expectTypeOf(deferQueue<"welcome">).returns.toEqualTypeOf<void>()
})

it("narrows Queue results by the error element", async () => {
  const [error, result] = await runQueue("welcome", { email: "ada@example.test" })
  if (error) {
    expectTypeOf(error.code).toEqualTypeOf<QueueErrorCode>()
    expectTypeOf(error.why).toEqualTypeOf<string>()
    expectTypeOf(result).toEqualTypeOf<undefined>()
    return
  }
  expectTypeOf(result).toEqualTypeOf<QueueSendResult>()

  const client = await getQueue("welcome")
  if (client.provider === "cloudflare") {
    const [sendError] = await client.send({ email: "ada@example.test" })
    if (sendError) {
      expectTypeOf(sendError.code).toEqualTypeOf<"QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION">()
      // @ts-expect-error A Cloudflare send never returns an invalid provider response.
      void (sendError.code === "QUEUE_PROVIDER_INVALID_RESPONSE")
    }
  }
})

const welcome = defineQueue<{ email: string }>(job => job.payload.email)
const audit = defineQueue<{ payload: string, region: string, id: string }>(job => job.payload.id)

declare module "../src/types.ts" {
  interface QueueRegistry {
    welcome: typeof welcome
    audit: typeof audit
  }
}

it("checks dispatch against the selected Queue Definition", async () => {
  await runQueue("welcome", { email: "ada@example.test" }, { delaySeconds: 1 })
  deferQueue("audit", { payload: "event", region: "business", id: "row-1" })
  const client = await getQueue("welcome")
  await client.send({ email: "ada@example.test" }, { id: "job-1" })
  // @ts-expect-error Payload belongs to welcome, not audit.
  await runQueue("welcome", { payload: "event", region: "business", id: "row-1" })
  // @ts-expect-error No envelope form remains.
  await runQueue("welcome", { payload: { email: "ada@example.test" }, delaySeconds: 1 })
  // @ts-expect-error Named clients retain their definition's payload.
  await client.send({ count: 1 })
  if (client.provider === "cloudflare") {
    await client.sendBatch([{ body: { email: "ada@example.test" } }])
    // @ts-expect-error A batch does not accept one message ID.
    await client.sendBatch([{ body: { email: "ada@example.test" } }], { id: "job-1" })
    // @ts-expect-error Batch payloads also belong to the named definition.
    await client.sendBatch([{ body: { count: 1 } }])
  }
  const selected: "welcome" | "audit" = Math.random() > 0.5 ? "welcome" : "audit"
  // @ts-expect-error A union name cannot accept input valid for only one possible target.
  await runQueue(selected, { email: "ada@example.test" })
  // @ts-expect-error Missing definition name.
  await getQueue("missing")
  const name: string = "external-name"
  // @ts-expect-error Operational names require explicit dynamic dispatch.
  deferQueue(name, { email: "ada@example.test" })
  await dynamicQueue.run(name, { arbitrary: true })
})
