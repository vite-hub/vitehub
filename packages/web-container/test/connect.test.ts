import { describe, expect, it } from "vitest"

import { connectEnv, defineConnect } from "../src/connect.ts"

describe("defineConnect", () => {
  it("asks for a pasted token when no OAuth app is configured", () => {
    expect(defineConnect({ github: true, vercel: true }).providers).toEqual([
      { name: "github", kind: "source", reach: "browser", auth: "token", env: "GITHUB_TOKEN" },
      { name: "vercel", kind: "deploy", reach: "browser", auth: "token", env: "VERCEL_TOKEN" },
    ])
  })

  it("uses OAuth when a Vercel client ID or a GitHub App is configured", () => {
    const { providers } = defineConnect({ github: { app: "vitehub-docs" }, vercel: { clientId: "oac_123" } })
    expect(providers).toEqual([
      { name: "github", kind: "source", reach: "browser", auth: "oauth", app: "vitehub-docs", env: "GITHUB_TOKEN" },
      { name: "vercel", kind: "deploy", reach: "browser", auth: "oauth", clientId: "oac_123", env: "VERCEL_TOKEN" },
    ])
  })

  it("marks Cloudflare as relay-only and model keys as browser reach", () => {
    const { providers } = defineConnect({ anthropic: true, cloudflare: { relay: "reader" }, netlify: true, openai: true })
    expect(providers.map(provider => [provider.name, provider.kind, provider.reach, provider.env])).toEqual([
      ["anthropic", "model", "browser", "ANTHROPIC_API_KEY"],
      ["cloudflare", "deploy", "relay", "CLOUDFLARE_API_TOKEN"],
      ["netlify", "deploy", "browser", "NETLIFY_AUTH_TOKEN"],
      ["openai", "model", "browser", "OPENAI_API_KEY"],
    ])
    expect(providers[1]?.relay).toBe("reader")
  })

  it("rejects an unknown provider", () => {
    expect(() => defineConnect(JSON.parse('{"gitlab":true}'))).toThrow(/Unknown connect provider "gitlab"/)
  })
})

describe("connectEnv", () => {
  it("maps only configured providers with a credential", () => {
    const connect = defineConnect({ openai: true, vercel: true })
    expect(connectEnv(connect, { anthropic: "sk-ant", openai: "sk-openai", vercel: "" })).toEqual({ OPENAI_API_KEY: "sk-openai" })
  })
})
