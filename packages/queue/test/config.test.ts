import { describe, expect, it } from "vitest"

import { normalizeQueueOptions } from "../src/config.ts"
import {
  configureCloudflareQueues,
  getCloudflareQueueBindingName,
  getCloudflareQueueDefinitionName,
  getCloudflareQueueName,
} from "../src/integrations/cloudflare.ts"
import { shouldConfigureVercelQueueBuildOutput } from "../src/integrations/vercel.ts"
import { getVercelQueueTopicName } from "../src/integrations/vercel-topic.ts"

describe("normalizeQueueOptions", () => {
  it("falls back to memory locally", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "" })).toEqual({
      provider: {
        provider: "memory",
      },
    })
  })

  it("short-circuits disabled config", () => {
    expect(normalizeQueueOptions(false, { hosting: "vercel" })).toBeUndefined()
  })

  it("lets explicit config beat hosting defaults", () => {
    expect(normalizeQueueOptions({
      provider: "memory",
    }, {
      hosting: "cloudflare-module",
    })).toEqual({
      provider: {
        provider: "memory",
      },
    })
  })

  it("uses Cloudflare defaults when hosting resolves to Cloudflare", () => {
    expect(normalizeQueueOptions(undefined, {
      hosting: "cloudflare-module",
    })).toEqual({
      provider: {
        provider: "cloudflare",
      },
    })
  })

  it("uses Vercel defaults when hosting resolves to Vercel", () => {
    expect(normalizeQueueOptions(undefined, {
      hosting: "vercel",
    })).toEqual({
      provider: {
        provider: "vercel",
      },
    })
  })

  it("rejects non-object config", () => {
    expect(() => normalizeQueueOptions(true as never)).toThrow("`queue` must be a plain object.")
  })

  it("rejects invalid provider values even when they are falsy", () => {
    for (const provider of ["", 0, false, null]) {
      expect(() => normalizeQueueOptions({ provider } as never)).toThrow("Unknown `queue.provider`")
    }
  })
})

describe("Cloudflare integration", () => {
  it("derives stable binding names", () => {
    expect(getCloudflareQueueBindingName("welcome-email")).toBe("QUEUE_WELCOME_EMAIL")
    expect(getCloudflareQueueBindingName("email/welcome")).toBe("QUEUE_EMAIL_WELCOME")
  })

  it("keeps valid queue names readable and encodes nested names", () => {
    expect(getCloudflareQueueName("welcome-email")).toBe("welcome-email")
    expect(getCloudflareQueueName("email/welcome")).toBe("queue--656d61696c2f77656c636f6d65")
    expect(getCloudflareQueueDefinitionName("queue--656d61696c2f77656c636f6d65")).toBe("email/welcome")
  })

  it("does not decode valid user queue names matching the old encoded format", () => {
    expect(getCloudflareQueueName("queue-6162")).toBe("queue-6162")
    expect(getCloudflareQueueDefinitionName("queue-6162")).toBe("queue-6162")
  })

  it("rejects user queue names matching the reserved encoded format", () => {
    expect(() => getCloudflareQueueName("queue--6162")).toThrow("reserved by @vitehub/queue")
  })

  it("registers queue producers and consumers only once", () => {
    const target: {
      cloudflare?: {
        wrangler?: {
          queues?: {
            consumers?: Array<Record<string, unknown>>
            producers?: Array<Record<string, unknown>>
          }
        }
      }
    } = {}
    const definitions = [{ handler: "/server/queues/welcome-email.ts", name: "welcome-email" }]
    const provider = { provider: "cloudflare" as const }

    configureCloudflareQueues(target, definitions, provider)
    configureCloudflareQueues(target, definitions, provider)

    expect(target.cloudflare!.wrangler!.queues).toEqual({
      consumers: [{ queue: "welcome-email" }],
      producers: [{ binding: "QUEUE_WELCOME_EMAIL", queue: "welcome-email" }],
    })
  })

  it("rejects shared explicit Cloudflare bindings for multiple definitions", () => {
    const target: {
      cloudflare?: {
        wrangler?: {
          queues?: {
            consumers?: Array<Record<string, unknown>>
            producers?: Array<Record<string, unknown>>
          }
        }
      }
    } = {}
    const definitions = [
      { handler: "/server/queues/email.ts", name: "email" },
      { handler: "/server/queues/report.ts", name: "report" },
    ]
    const provider = { binding: "QUEUE", provider: "cloudflare" as const }

    expect(() => configureCloudflareQueues(target, definitions, provider)).toThrow(
      "`queue.provider.binding` can only be used with one Cloudflare queue definition.",
    )
  })

  it("writes Cloudflare-safe queue names for nested definitions", () => {
    const target: {
      cloudflare?: {
        wrangler?: {
          queues?: {
            consumers?: Array<Record<string, unknown>>
            producers?: Array<Record<string, unknown>>
          }
        }
      }
    } = {}
    const definitions = [{ handler: "/server/queues/email/welcome.ts", name: "email/welcome" }]

    configureCloudflareQueues(target, definitions, { provider: "cloudflare" })

    expect(target.cloudflare!.wrangler!.queues).toEqual({
      consumers: [{ queue: "queue--656d61696c2f77656c636f6d65" }],
      producers: [{ binding: "QUEUE_EMAIL_WELCOME", queue: "queue--656d61696c2f77656c636f6d65" }],
    })
  })
})

describe("Vercel integration", () => {
  it("keeps valid topic names readable and encodes nested names", () => {
    expect(getVercelQueueTopicName("welcome-email")).toBe("welcome-email")
    expect(getVercelQueueTopicName("email/welcome")).toBe("queue_656d61696c2f77656c636f6d65")
  })

  it("configures build output when Vercel is inferred from the Nitro preset", () => {
    const nitro = {
      options: {
        dev: false,
        preset: "vercel",
      },
    }

    expect(shouldConfigureVercelQueueBuildOutput(nitro as never, undefined)).toBe(true)
  })

  it("skips build output outside Vercel", () => {
    const nitro = {
      options: {
        dev: false,
        preset: "cloudflare-module",
      },
    }

    expect(shouldConfigureVercelQueueBuildOutput(nitro as never, undefined)).toBe(false)
  })
})
