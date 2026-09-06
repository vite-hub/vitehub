import { afterEach, expect, it, vi } from "vitest"

import { defineQueue } from "../src/definition.ts"
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
    await dynamicQueue.run("audit", payload, { delaySeconds: 5, id: "dispatch-id" })
  }
  expect(sent.map(call => call.payload)).toEqual(payloads)
  for (const call of sent) {
    expect(call.options).toMatchObject({ delaySeconds: 5 })
    expect(call.options).not.toMatchObject({ region: "business-region" })
  }
  if (provider === "vercel") {
    expect(sent[0]?.options).toMatchObject({ idempotencyKey: "dispatch-id" })
    await expect(client.send(payloads[0], { contentType: "json" })).rejects.toMatchObject({ code: "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS" })
  }
  else {
    await expect(client.send(payloads[0], { region: "iad1" })).rejects.toMatchObject({ code: "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS" })
  }
})
