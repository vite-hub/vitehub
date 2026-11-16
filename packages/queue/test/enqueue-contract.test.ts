import { afterEach, expect, it, vi } from "vitest"

import { defineQueue } from "../src/definition.ts"
import { normalizeQueueEnqueueInput } from "../src/enqueue.ts"
import { createCloudflareQueueClient } from "../src/providers/cloudflare.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"
import { dynamicQueue } from "../src/runtime/client.ts"
import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import type { QueueEnqueueOptions } from "../src/types.ts"

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
    expect((await dynamicQueue.send("audit", payload, { delaySeconds: 5 }))[0]).toBeUndefined()
  }
  expect(sent.map(call => call.payload)).toEqual(payloads)
  for (const call of sent) {
    expect(call.options).toMatchObject({ delaySeconds: 5 })
    expect(call.options).not.toMatchObject({ region: "business-region" })
  }
  if (provider === "vercel") {
    expect(sent[0]?.options).toMatchObject({ idempotencyKey: expect.any(String) })
    await expect(client.send(payloads[0], { contentType: "json" })).resolves.toMatchObject([{ code: "QUEUE_UNSUPPORTED_OPTION" }, undefined])
  }
  else {
    await expect(client.send(payloads[0], { region: "iad1" })).resolves.toMatchObject([{ code: "QUEUE_UNSUPPORTED_OPTION" }, undefined])
  }
})

it.each(["cloudflare", "vercel"] as const)("rejects a caller message id through %s before the provider call", async (provider) => {
  const send = vi.fn(async () => ({ messageId: "provider-id" }))
  const client = provider === "cloudflare"
    ? createCloudflareQueueClient({ provider, binding: { send, sendBatch: vi.fn(async () => {}) } })
    : await createVercelQueueClient({ provider, topic: "audit", client: { send, handleCallback: vi.fn() } })

  // SAFETY: A JavaScript caller can still pass the removed `id` option.
  const [error, result] = await client.send("event", { id: "own-id" } as QueueEnqueueOptions)
  expect(result).toBeUndefined()
  expect(error).toMatchObject({
    code: "QUEUE_UNSUPPORTED_OPTION",
    fix: "Remove `id`. ViteHub generates the message ID. To deduplicate sends, pass `idempotencyKey` on a provider that supports it.",
  })
  expect(send).not.toHaveBeenCalled()
})

it("returns no message id from Cloudflare, which assigns the id that the handler gets", async () => {
  const client = createCloudflareQueueClient({ provider: "cloudflare", binding: { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) } })

  expect(await client.send("event")).toEqual([undefined, { status: "queued" }])
})

it("generates the message id and ignores an inherited id", () => {
  const inherited = Object.create({ id: "inherited-id" }) as QueueEnqueueOptions
  const input = normalizeQueueEnqueueInput("event", inherited)

  expect(input.id).toMatch(/^queue_/)
  expect(input.options).toEqual({})
})
