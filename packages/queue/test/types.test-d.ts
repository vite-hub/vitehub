import type { UserConfig } from "vite"

import { describe, expectTypeOf, it } from "vitest"

import {
  defineQueue,
  getQueue,
  runQueue,
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
  })

  it("augments Vite user config with queue options", () => {
    const config: UserConfig = {
      queue: {
        provider: "cloudflare",
      },
    }

    expectTypeOf(config.queue).toMatchTypeOf<QueueModuleOptions | undefined>()
  })

  it("returns a Vite plugin with a Nitro bridge", () => {
    const plugin = hubQueue()

    expectTypeOf(plugin.nitro).toMatchTypeOf<{ name?: string }>()
  })

  it("narrows provider-specific clients", async () => {
    const queue = await getQueue("welcome-email")
    if (queue.provider === "vercel") {
      expectTypeOf(queue).toMatchTypeOf<VercelQueueClient>()
    }
  })
})
