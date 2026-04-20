import { afterEach, describe, expect, it, vi } from "vitest"

import { deferQueue } from "../src/runtime/client.ts"
import { getCloudflareQueueName } from "../src/integrations/cloudflare.ts"
import { getQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/runtime/state.ts"

const runtimeState = vi.hoisted(() => ({
  runtimeConfig: {
    queue: {
      provider: "cloudflare",
    },
  },
}))

const registryState = vi.hoisted(() => ({
  registry: {} as Record<string, () => Promise<{ default: { handler: () => Promise<void> } }>>,
}))

vi.mock("nitro", () => ({
  definePlugin: (plugin: unknown) => plugin,
}))

vi.mock("nitro/runtime-config", () => ({
  useRuntimeConfig: () => runtimeState.runtimeConfig,
}))

vi.mock("#vitehub/queue/registry", () => ({
  default: registryState.registry,
}))

afterEach(() => {
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
  runtimeState.runtimeConfig = {
    queue: {
      provider: "cloudflare",
    },
  }
  for (const key of Object.keys(registryState.registry)) {
    delete registryState.registry[key]
  }
  registryState.registry.welcome = async () => ({
    default: {
      handler: async () => {},
    },
  })
  vi.restoreAllMocks()
})

registryState.registry.welcome = async () => ({
  default: {
    handler: async () => {},
  },
})

describe("Nitro runtime plugin", () => {
  it("captures request events for request-scoped queue APIs", async () => {
    const requestHooks = new Map<string, (payload: any) => unknown>()
    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default
    plugin({
      hooks: {
        hook(name: string, handler: (payload: any) => unknown) {
          requestHooks.set(name, handler)
          return () => {}
        },
      },
    } as never)

    const event = {
      context: {
        cloudflare: {
          env: {
            QUEUE_77656C636F6D65: {
              send: vi.fn(async () => {}),
              sendBatch: vi.fn(async () => {}),
            },
          },
        },
      },
      waitUntil: vi.fn(),
    }

    requestHooks.get("request")!(event)
    expect(getQueueRuntimeEvent()).toBe(event)

    deferQueue("welcome", { email: "ava@example.com" })
    expect(event.waitUntil).toHaveBeenCalledTimes(1)
  })

  it("dispatches Cloudflare queue batches through Nitro hooks", async () => {
    const queueHandler = vi.fn(async () => {})
    registryState.registry.welcome = async () => ({
      default: {
        handler: queueHandler,
      },
    })

    const hooks = new Map<string, (payload: any) => unknown>()
    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default
    plugin({
      hooks: {
        hook(name: string, handler: (payload: any) => unknown) {
          hooks.set(name, handler)
          return () => {}
        },
      },
    } as never)

    await hooks.get("cloudflare:queue")!({
      batch: {
        ackAll: vi.fn(),
        messages: [{
          ack: vi.fn(),
          attempts: 1,
          body: { email: "ava@example.com" },
          id: "message-1",
          retry: vi.fn(),
        }],
        queue: getCloudflareQueueName("welcome"),
        retryAll: vi.fn(),
      },
      context: {
        waitUntil: vi.fn(),
      },
      env: {},
    })

    expect(queueHandler).toHaveBeenCalledTimes(1)
  })
})
