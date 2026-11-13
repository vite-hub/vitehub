import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { getDeploymentHost } from "@vite-hub/internal/build/vite"

import { detectHost } from "../src/deployment.ts"
import { vitehub } from "../src/index.ts"

const hostVariables = [
  "VITEHUB_HOST",
  "NITRO_PRESET",
  "SERVER_PRESET",
  "CF_PAGES",
  "WORKERS_CI",
  "NETLIFY",
  "NOW_BUILDER",
  "VERCEL",
  "VERCEL_ENV",
  "DENO_DEPLOY",
  "DENO_DEPLOYMENT_ID",
]

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("detectHost", () => {
  it.each([
    [{ WORKERS_CI: "1" }, "cloudflare"],
    [{ VERCEL: "1" }, "vercel"],
    [{ NETLIFY: "true" }, "netlify"],
    [{ DENO_DEPLOYMENT_ID: "abc123" }, "deno"],
  ] as const)("detects the host from the provider variables in %o", (env, host) => {
    expect(detectHost(env)).toBe(host)
  })

  it("prefers VITEHUB_HOST, then NITRO_PRESET and SERVER_PRESET, over provider variables", () => {
    expect(detectHost({ VITEHUB_HOST: "netlify", NITRO_PRESET: "vercel", VERCEL: "1" })).toBe("netlify")
    expect(detectHost({ NITRO_PRESET: "cloudflare_module", SERVER_PRESET: "vercel", VERCEL: "1" })).toBe("cloudflare")
    expect(detectHost({ SERVER_PRESET: "node-server", VERCEL: "1" })).toBe("node")
  })

  it("returns undefined without a known host, and skips empty values and Cloudflare Pages", () => {
    expect(detectHost({})).toBeUndefined()
    expect(detectHost({ VITEHUB_HOST: " ", VERCEL: "" })).toBeUndefined()
    expect(detectHost({ CF_PAGES: "1" })).toBeUndefined()
  })

  it("reads process.env by default", () => {
    for (const name of hostVariables) vi.stubEnv(name, "")
    vi.stubEnv("NETLIFY", "true")
    expect(detectHost()).toBe("netlify")
  })
})

describe("vitehub() without a host", () => {
  async function buildConfig() {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-detect-"))
    onTestFinished(() => rm(root, { force: true, recursive: true }))
    const config = await resolveConfig({
      root,
      plugins: [vitehub({ blob: false, env: false, queue: false, rateLimit: false })],
    }, "build")
    return config as typeof config & { nitro?: { preset?: string } }
  }

  it.each([
    ["WORKERS_CI", "1", "cloudflare", "cloudflare-module"],
    ["VERCEL", "1", "vercel", "vercel"],
    ["NETLIFY", "true", "netlify", "netlify"],
    ["DENO_DEPLOYMENT_ID", "abc123", "deno", "deno-server"],
  ] as const)("builds for the host that %s=%s names", async (name, value, host, nitroPreset) => {
    for (const variable of hostVariables) vi.stubEnv(variable, "")
    vi.stubEnv(name, value)
    const config = await buildConfig()
    expect(getDeploymentHost(config)).toBe(host)
    expect(config.nitro?.preset).toBe(nitroPreset)
  })

  it("builds for Node when no variable names a host", async () => {
    for (const variable of hostVariables) vi.stubEnv(variable, "")
    const config = await buildConfig()
    expect(getDeploymentHost(config)).toBe("node")
    expect(config.nitro?.preset).toBe("node-server")
  })

  it("needs no options", async () => {
    for (const variable of hostVariables) vi.stubEnv(variable, "")
    const root = await mkdtemp(join(tmpdir(), "vitehub-no-options-"))
    onTestFinished(() => rm(root, { force: true, recursive: true }))
    const config = await resolveConfig({ root, plugins: [vitehub()] }, "build")
    expect(getDeploymentHost(config)).toBe("node")
  })

  it("follows NITRO_PRESET instead of failing on a conflict", async () => {
    for (const variable of hostVariables) vi.stubEnv(variable, "")
    vi.stubEnv("NITRO_PRESET", "vercel")
    vi.stubEnv("NETLIFY", "true")
    const config = await buildConfig()
    expect(config.nitro?.preset).toBe("vercel")
  })
})
