import { afterEach, describe, expect, it } from "vitest"

import { detectHosting } from "../src/hosting.ts"

afterEach(() => {
  delete process.env.VITEHUB_HOSTING
})

describe("hosting detection", () => {
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
