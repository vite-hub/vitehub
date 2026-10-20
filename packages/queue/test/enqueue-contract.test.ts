import { afterEach, expect, it, vi } from "vitest"

import { defineQueue } from "../src/definition.ts"
import { normalizeQueueEnqueueInput } from "../src/enqueue.ts"
import { createCloudflareQueueClient } from "../src/providers/cloudflare.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"
import { dynamicQueue } from "../src/runtime/client.ts"
import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"

afterEach(() => {
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
})

it.each(["cloudflare", "vercel"] as const)("preserves business option names through %s enqueue", async (provider) => {
  const sent: { payload: unknown, options: unknown }[] = []
  const client = provider === "cloudflare"
    ? createCloudflareQueueClient({
        provider,
        binding: {
          send: async (payload, options) => { sent.push({ payload, options }) },
          sendBatch: vi.fn(async () => {}),
        },
      })
    : await createVercelQueueClient({
        provider,
        topic: "audit",
        client: {
          send: async (_topic, payload, options) => {
            sent.push({ payload, options })
            return { messageId: "provider-id" }
          },
          handleCallback: vi.fn(),
        },
      })
  setQueueRuntimeConfig({ provider }, async () => client)
  setQueueRuntimeRegistry({ audit: async () => defineQueue(() => {}) })

  const payloads = [
    { payload: "event" },
    { payload: "event", region: "business-region", id: "business-id" },
    { payload: "event", region: "business-region", id: "business-id", kind: "audit" },
  ]
  for (const payload of payloads) {
    expect((await dynamicQueue.run("audit", payload, { delaySeconds: 5, id: "dispatch-id" }))[0]).toBeUndefined()
  }
  expect(sent.map(call => call.payload)).toEqual(payloads)
  for (const call of sent) {
    expect(call.options).toMatchObject({ delaySeconds: 5 })
    expect(call.options).not.toMatchObject({ region: "business-region" })
  }
  if (provider === "vercel") {
    expect(sent[0]?.options).toMatchObject({ idempotencyKey: "dispatch-id" })
    await expect(client.send(payloads[0], { contentType: "json" })).resolves.toMatchObject([{ code: "QUEUE_UNSUPPORTED_OPTION" }, undefined])
  }
  else {
    await expect(client.send(payloads[0], { region: "iad1" })).resolves.toMatchObject([{ code: "QUEUE_UNSUPPORTED_OPTION" }, undefined])
  }
})

it.each(["cloudflare", "vercel"] as const)("ignores inherited enqueue ids through %s", async (provider) => {
  const sent: { options: unknown }[] = []
  const client = provider === "cloudflare"
    ? createCloudflareQueueClient({
        provider,
        binding: {
          send: async (_payload, options) => { sent.push({ options }) },
          sendBatch: vi.fn(async () => {}),
        },
      })
    : await createVercelQueueClient({
        provider,
        topic: "audit",
        client: {
          send: async (_topic, _payload, options) => {
            sent.push({ options })
            return { messageId: "provider-id" }
          },
          handleCallback: vi.fn(),
        },
      })

  const options = Object.create({ id: "inherited-id" }) as { id?: string }
  const [error, result] = await client.send("event", options)

  expect(error).toBeUndefined()
  expect(result?.messageId).not.toBe("inherited-id")
  expect(sent[0]?.options).not.toHaveProperty("id", "inherited-id")
  if (provider === "vercel") {
    expect(sent[0]?.options).toMatchObject({ idempotencyKey: expect.any(String) })
    expect(sent[0]?.options).not.toMatchObject({ idempotencyKey: "inherited-id" })
  }
})


it.each([true, false])("reads an own enqueue id getter once when enumerable is %s", (enumerable) => {
  const readId = vi.fn(() => "own-id")
  const options = Object.defineProperty({ delaySeconds: 5 }, "id", { enumerable, get: readId })

  expect(normalizeQueueEnqueueInput("event", options)).toEqual({
    id: "own-id",
    options: { delaySeconds: 5 },
    payload: "event",
  })
  expect(readId).toHaveBeenCalledOnce()
})
