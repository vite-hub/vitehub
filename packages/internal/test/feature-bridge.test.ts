import { afterEach, describe, expect, it } from "vitest"

import {
  buildFeatureViteContext,
  createFeatureEngine,
} from "../src/feature-bridge/feature-engine.ts"
import { detectHosting } from "../src/feature-bridge/hosting.ts"

afterEach(() => {
  delete process.env.VITEHUB_HOSTING
})

describe("feature bridge hosting", () => {
  it("prefers configured ViteHub preset over hosting env", () => {
    process.env.VITEHUB_HOSTING = "cloudflare"

    expect(detectHosting({
      options: {
        preset: "vercel",
      },
    })).toBe("vercel")
  })

  it("falls back to explicit ViteHub hosting env", () => {
    process.env.VITEHUB_HOSTING = "vercel"

    expect(detectHosting({
      options: {},
    })).toBe("vercel")
  })
})

describe("feature bridge state", () => {
  it("preserves explicit false config in Vite runtime config", async () => {
    const engine = createFeatureEngine<false | { enabled: boolean }, { enabled: boolean }, false | { enabled: boolean }>({
      name: "@vite-hub/test-feature",
      feature: "testFeature",
      configKey: "testFeature",
      normalizeOptions(options) {
        if (options === false) return
        return options
      },
      readPublicOptions(source) {
        return source.userConfig.testFeature as false | { enabled: boolean } | undefined
      },
    })

    const context = await buildFeatureViteContext(engine, {
      root: process.cwd(),
      testFeature: false,
    }, {
      command: "build",
      mode: "production",
    })

    expect(context?.runtimeConfig).toEqual({
      testFeature: false,
    })
    expect(context?.config).toBe(false)
  })
})
