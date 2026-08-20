import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { env, hubEnv } from "@vite-hub/env/vite"
import { vitehub } from "../src/index.ts"

import type { EnvViteUserConfig } from "@vite-hub/env"

describe("built-in deployment preset integration", () => {
  it.each(["cloudflare", "netlify", "vercel", "deno", "node"] as const)("resolves the minimal %s preset with real owner plugins", async (preset) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-config-"))
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        preset,
        blob: false,
        env: false,
        queue: false,
        rateLimit: false,
      })],
    }, "build")
    expect(config.plugins.map(plugin => plugin.name)).not.toContain("@vite-hub/sandbox/vite")
    expect((config as typeof config & { nitro?: { preset?: string } }).nitro?.preset).toBeTruthy()
  })

  it("applies deployment-owned Nitro configuration only during build", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-command-"))
    try {
      const developmentConfig = {
        nitro: {
          modules: ["local-module"],
          preset: "node-server",
        },
        root,
        plugins: [vitehub({
          preset: "cloudflare",
          blob: false,
          env: false,
          queue: false,
          rateLimit: false,
        })],
        vitehub: {
          marker: "preserved",
        },
      } as Parameters<typeof resolveConfig>[0] & {
        nitro: { modules: string[], preset: string }
        vitehub: { marker: string }
      }
      const development = await resolveConfig(developmentConfig, "serve")
      expect((development as typeof development & {
        nitro?: { modules?: unknown[], preset?: string }
      }).nitro).toMatchObject({
        modules: ["local-module"],
        preset: "node-server",
      })
      expect(development.vitehub).toEqual({
        marker: "preserved",
        preset: "cloudflare",
      })

      const production = await resolveConfig({
        root,
        plugins: [vitehub({
          preset: "cloudflare",
          blob: false,
          env: false,
          queue: false,
          rateLimit: false,
        })],
      }, "build")
      expect((production as typeof production & {
        nitro?: { modules?: unknown[], preset?: string }
      }).nitro).toMatchObject({
        modules: [expect.any(Function)],
        preset: "cloudflare-module",
      })
      expect(production.vitehub).toEqual({
        preset: "cloudflare",
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("preserves a Worker name configured through the Nitro plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-worker-name-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [
          vitehub({ name: "logical-app", preset: "cloudflare" }),
          {
            name: "nitro-config",
            config() {
              return {
                nitro: {
                  cloudflare: {
                    wrangler: {
                      name: "physical-worker",
                    },
                  },
                },
              } as never
            },
          },
        ],
      }, "build")
      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { name?: string } } }
      }).nitro?.cloudflare?.wrangler?.name).toBe("physical-worker")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares exact required Server Env secrets in Cloudflare output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-required-secrets-"))
    try {
      const config = await resolveConfig({
        env: {
          server: {
            nested: {
              required: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
              optional: env({ optional: true, secret: true, source: env.source("OPTIONAL_TOKEN") }),
              alternatives: env({ secret: true, source: env.source(["PRIMARY_TOKEN", "FALLBACK_TOKEN"]) }),
              publicValue: env({ source: env.source("PUBLIC_VALUE") }),
            },
          },
        },
        nitro: {
          cloudflare: {
            wrangler: {
              secrets: { required: ["APP_SECRET"] },
            },
          },
        },
        root,
        plugins: [vitehub({ preset: "cloudflare" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required).toEqual(["APP_SECRET", "VITEHUB_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares required secrets from a standalone Env plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-standalone-required-secrets-"))
    try {
      const config = await resolveConfig({
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [
          vitehub({ env: false, preset: "cloudflare" }),
          hubEnv(),
        ],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required).toEqual(["VITEHUB_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares required secrets in named environments from later post hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-late-required-secrets-"))
    try {
      const config = await resolveConfig({
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [
          vitehub({ preset: "cloudflare" }),
          {
            name: "app/cloudflare-environments",
            enforce: "post",
            config() {
              return {
                nitro: {
                  cloudflare: {
                    wrangler: {
                      env: { staging: { name: "staging-worker" } },
                    },
                  },
                },
              }
            },
          },
        ],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { env?: { staging?: { secrets?: { required?: string[] } } } } } }
      }).nitro?.cloudflare?.wrangler?.env?.staging?.secrets?.required).toEqual(["VITEHUB_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps required Server Env secrets out of non-Cloudflare output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-node-required-secrets-"))
    try {
      const config = await resolveConfig({
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [vitehub({ preset: "node" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & { nitro?: { cloudflare?: unknown } }).nitro?.cloudflare).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
