import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { vitehub } from "../src/index.ts"

const hostVariables = [
  "VITEHUB_HOSTING",
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

describe("vitehub() without a preset", () => {
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
  ] as const)("builds for the host that %s=%s names", async (name, value, preset, nitroPreset) => {
    for (const variable of hostVariables) vi.stubEnv(variable, "")
    vi.stubEnv(name, value)
    const config = await buildConfig()
    expect(config.vitehub).toEqual({ preset })
    expect(config.nitro?.preset).toBe(nitroPreset)
  })

  it("builds for Node when no variable names a host", async () => {
    for (const variable of hostVariables) vi.stubEnv(variable, "")
    const config = await buildConfig()
    expect(config.vitehub).toEqual({ preset: "node" })
    expect(config.nitro?.preset).toBe("node-server")
  })

  it("needs no options", async () => {
    for (const variable of hostVariables) vi.stubEnv(variable, "")
    const root = await mkdtemp(join(tmpdir(), "vitehub-no-options-"))
    onTestFinished(() => rm(root, { force: true, recursive: true }))
    const config = await resolveConfig({ root, plugins: [vitehub()] }, "build")
    expect(config.vitehub).toEqual({ preset: "node" })
  })

  it("follows NITRO_PRESET instead of failing on a conflict", async () => {
    for (const variable of hostVariables) vi.stubEnv(variable, "")
    vi.stubEnv("NITRO_PRESET", "vercel")
    vi.stubEnv("NETLIFY", "true")
    const config = await buildConfig()
    expect(config.nitro?.preset).toBe("vercel")
  })
})
