import type { UserConfig } from "vite"

import { describe, expectTypeOf, it } from "vitest"

import {
  createQueue,
  defineQueue,
  getQueue,
  runQueue,
  type CreateQueueDefinitionInput,
  type QueueModuleOptions,
  type VercelQueueClient,
} from "../src/index.ts"
import { hubQueue } from "../src/vite.ts"

describe("types", () => {
  it("infers queue payloads in defineQueue", () => {
    const queue = defineQueue<{ email: string }>(async (job) => {
      expectTypeOf(job.payload.email).toEqualTypeOf<string>()
      return { ok: true }
    })

    expectTypeOf(queue.handler).toBeFunction()
  })

  it("accepts bare payload and enqueue object inputs", async () => {
    await runQueue("welcome-email", { email: "ava@example.com" })
    await runQueue("welcome-email", {
      id: "welcome-ava",
      payload: { email: "ava@example.com" },
      retentionSeconds: 3600,
    })
    await runQueue("welcome-email", {
      payload: { email: "ava@example.com" },
      region: "iad1",
    })
  })

  it("keeps createQueue compatibility types", () => {
    const input: CreateQueueDefinitionInput<{ email: string }, { ok: true }> = {
      handler: async (job) => {
        expectTypeOf(job.payload.email).toEqualTypeOf<string>()
        return { ok: true }
      },
    }

    const queue = createQueue(input)
    expectTypeOf(queue.handler).toBeFunction()
  })

  it("augments Vite user config with queue options", () => {
    const config: UserConfig = {
      queue: {
        provider: "cloudflare",
      },
    }

    expectTypeOf(config.queue).toMatchTypeOf<QueueModuleOptions | undefined>()
  })

  it("keeps module config serializable", () => {
    const validConfig: QueueModuleOptions = {
      binding: "QUEUE_EMAIL",
      provider: "cloudflare",
    }
    expectTypeOf(validConfig).toMatchTypeOf<QueueModuleOptions>()

    const invalidCloudflareConfig: QueueModuleOptions = {
      // @ts-expect-error Nitro module config must not contain runtime binding objects.
      binding: { send: async () => undefined, sendBatch: async () => undefined },
      provider: "cloudflare",
    }
    expectTypeOf(invalidCloudflareConfig).toMatchTypeOf<QueueModuleOptions>()

    const invalidVercelConfig: QueueModuleOptions = {
      // @ts-expect-error Nitro module config must not contain runtime queue clients.
      client: { handleCallback: () => async () => undefined, send: async () => ({}) },
      provider: "vercel",
    }
    expectTypeOf(invalidVercelConfig).toMatchTypeOf<QueueModuleOptions>()

    const invalidMemoryConfig: QueueModuleOptions = {
      // @ts-expect-error Memory is internal test/dev support, not public module config.
      provider: "memory",
      store: { messages: [] },
    }
    expectTypeOf(invalidMemoryConfig).toMatchTypeOf<QueueModuleOptions>()
  })

  it("returns a Vite plugin", () => {
    const plugin = hubQueue()

    expectTypeOf(plugin).toMatchTypeOf<{ name?: string }>()
  })

  it("narrows provider-specific clients", async () => {
    const queue = await getQueue("welcome-email")
    if (queue.provider === "vercel") {
      expectTypeOf(queue).toMatchTypeOf<VercelQueueClient>()
    }
  })
})
