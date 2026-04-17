import { describe, expect, it } from "vitest"

import { normalizeQueueOptions } from "../src/config.ts"
import { configureCloudflareQueues } from "../src/integrations/cloudflare.ts"
import { shouldConfigureVercelQueueBuildOutput } from "../src/integrations/vercel.ts"
import { getCloudflareQueueBindingName } from "../src/providers/cloudflare.ts"

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
})

describe("Cloudflare integration", () => {
  it("derives stable binding names", () => {
    expect(getCloudflareQueueBindingName("welcome-email")).toBe("QUEUE_WELCOME_EMAIL")
    expect(getCloudflareQueueBindingName("email/welcome")).toBe("QUEUE_EMAIL_WELCOME")
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
})

describe("Vercel integration", () => {
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
