import { describe, expect, it, vi } from "vitest"

// The first run of the published extension loads the discovery of every owner package.

import {
  authRuntimeOptionsRule, awaitAsyncHelpers, checkRateLimitDecision, loadProviderEnv, noAgentConnectionActor, noLiteralCredentials,
  noNestedBlobReferenceSchema, rateLimiterAtModuleScope, unsealSecretEnv,
} from "../src/doctor/rules/env-and-guards.ts"
import { codes, doctorTestTimeout, projectCodes } from "./doctor-helpers.ts"

vi.setConfig({ testTimeout: doctorTestTimeout })

function envDescription(entries: { path: string, source: string, secret: boolean }[]) {
  const description = { entries: entries.map(entry => ({ ...entry, required: true, hasDefault: false })) }
  return `export function describeServerEnv() { return JSON.parse(${JSON.stringify(JSON.stringify(description))}); }\n`
}

const description = envDescription([
  { path: "env.server.github.token", source: "env", secret: true },
  { path: "env.server.airtableToken", source: "env", secret: true },
  { path: "env.server.dryRun", source: "env", secret: false },
  { path: "env.server.crm.key", source: "provider", secret: true },
])

describe("vitehub/unseal-secret-env", () => {
  it("reports secrets used as strings", async () => {
    expect(await projectCodes(unsealSecretEnv, {
      ".vitehub/env/description.mjs": description,
      "server/api/sync.post.ts": [
        'import { useServerEnv, loadServerEnv } from "#vitehub/env/server"',
        "export default defineEventHandler(async (event) => {",
        "  const env = useServerEnv(event)",
        "  const { airtableToken } = useServerEnv(event)",
        '  await fetch("https://api.github.com", { headers: { Authorization: `Bearer ${env.github.token}` } })',
        '  await fetch("https://api.airtable.com", { headers: { Authorization: airtableToken } })',
        '  if (event.headers.get("x-token") === useServerEnv(event).github.token) return',
        "  const loaded = await loadServerEnv(event)",
        "  return JSON.stringify(loaded.airtableToken)",
        "})",
      ].join("\n"),
    })).toEqual(Array(4).fill("VHUB0004"))
  })

  it("accepts unsealed secrets, non-secret values, and projects without generated Env", async () => {
    const route = [
      'import { useServerEnv } from "#vitehub/env/server"',
      "export default defineEventHandler(async (event) => {",
      "  const { github, dryRun } = useServerEnv(event)",
      '  await fetch("https://api.github.com", { headers: { Authorization: `Bearer ${github.token.unseal()}` } })',
      "  return `${dryRun}`",
      "})",
    ].join("\n")
    expect(await projectCodes(unsealSecretEnv, { ".vitehub/env/description.mjs": description, "server/api/sync.post.ts": route })).toEqual([])
    expect(await projectCodes(unsealSecretEnv, { "server/api/sync.post.ts": route.replace(".unseal()", "") })).toEqual([])
  })
})

describe("vitehub/no-literal-credentials", () => {
  it("reports secrets that config files write into the build", async () => {
    expect(await codes(noLiteralCredentials, {
      "vite.config.ts": [
        'import { defineConfig } from "vite"',
        'import { env, hubEnv } from "@vite-hub/env/vite"',
        'import { hubEmail } from "@vite-hub/email/vite"',
        "export default defineConfig({",
        "  plugins: [hubEnv(), hubEmail({ driver: 'resend', options: { apiKey: process.env.RESEND_API_KEY } })],",
        "  env: {",
        "    server: {",
        "      apiToken: 'sk-live-123',",
        "      github: { token: env({ secret: true, default: 'ghp_123' }) },",
        "      airtable: process.env.AIRTABLE_TOKEN,",
        "      region: env({ default: import.meta.env.REGION }),",
        "    },",
        "  },",
        "})",
      ].join("\n"),
    })).toEqual(Array(5).fill("VHUB0005"))
  })

  it("reports literal credentials in Auth, Connections, and gateway Definitions", async () => {
    expect(await codes(noLiteralCredentials, {
      "server/auth.ts": 'import { defineAuth } from "vite-hub/auth"\nexport default defineAuth(() => ({ socialProviders: { github: { clientId: "id", clientSecret: "shh" } } }))\n',
      "server/connections/google.ts": 'import { google } from "vite-hub/connections/google"\nexport default google({ clientId: "id", clientSecret: "GOCSPX-123" })\n',
      "server/agents/support.ts": 'import { openai } from "vite-hub/gateways"\nexport const gateway = openai({ apiKey: "sk-123", headers: { "x-key": "abc" } })\n',
    })).toEqual(Array(4).fill("VHUB0005"))
  })

  it("accepts declared sources, non-secret literals, and runtime values", async () => {
    expect(await codes(noLiteralCredentials, {
      "vite.config.ts": [
        'import { defineConfig } from "vite"',
        'import { env, hubEnv } from "@vite-hub/env/vite"',
        "export default defineConfig({",
        "  plugins: [hubEnv()],",
        "  env: { server: { logLevel: 'info', dryRun: env.boolean({ default: true }), apiToken: env({ secret: true, source: env.source('API_TOKEN') }) } },",
        "})",
      ].join("\n"),
      "server/agents/support.ts": 'import { openai } from "vite-hub/gateways"\nexport const gateway = openai({ apiKey: () => tenant.key, model: "gpt-5" })\n',
    })).toEqual([])
  })
})

describe("vitehub/await-async-helpers", () => {
  it("reports guards and Server Env helpers without await", async () => {
    expect(await codes(awaitAsyncHelpers, {
      "server/api/upload.post.ts": [
        'import { requireRateLimit } from "vite-hub/rate-limit"',
        'import { deriveSecret, loadServerEnv } from "#vitehub/env/server"',
        "export default defineEventHandler(async (event) => {",
        '  requireRateLimit(event, "upload", { limit: 10, window: "1m" })',
        '  const key = deriveSecret("app:session")',
        "  const { github } = loadServerEnv(event)",
        "  return `${key}${github}`",
        "})",
      ].join("\n"),
    })).toEqual(Array(3).fill("VHUB0006"))
  })

  it("accepts awaited and returned calls", async () => {
    expect(await codes(awaitAsyncHelpers, {
      "server/api/upload.post.ts": [
        'import { requireRateLimit } from "vite-hub/rate-limit"',
        'import { deriveSecret, loadServerEnv } from "#vitehub/env/server"',
        "export default defineEventHandler(async (event) => {",
        '  await requireRateLimit(event, "upload", { limit: 10, window: "1m" })',
        "  const pending = loadServerEnv(event)",
        "  const env = await pending",
        '  return { env, key: await deriveSecret("app:session") }',
        "})",
      ].join("\n"),
    })).toEqual([])
  })
})

describe("vitehub/load-provider-env", () => {
  it("reports provider-backed values read with useServerEnv()", async () => {
    expect(await projectCodes(loadProviderEnv, {
      ".vitehub/env/description.mjs": description,
      "server/api/crm.get.ts": 'import { useServerEnv } from "#vitehub/env/server"\nexport default defineEventHandler(event => useServerEnv(event).crm.key)\n',
      "server/api/crm-pattern.get.ts": 'import { useServerEnv } from "#vitehub/env/server"\nexport default defineEventHandler((event) => {\n  const { crm: { key } } = useServerEnv(event)\n  return key\n})\n',
    })).toEqual(["VHUB0007", "VHUB0007"])
  })

  it("accepts loadServerEnv() and host values", async () => {
    expect(await projectCodes(loadProviderEnv, {
      ".vitehub/env/description.mjs": description,
      "server/api/crm.get.ts": [
        'import { loadServerEnv, useServerEnv } from "#vitehub/env/server"',
        "export default defineEventHandler(async (event) => {",
        "  const { crm } = await loadServerEnv(event)",
        "  return [crm.key, useServerEnv(event).dryRun]",
        "})",
      ].join("\n"),
    })).toEqual([])
  })
})

describe("vitehub/check-rate-limit-decision", () => {
  it("reports decisions used as booleans or ignored", async () => {
    expect(await codes(checkRateLimitDecision, {
      "server/api/og.get.ts": [
        'import { checkRateLimit, createRateLimiter } from "vite-hub/rate-limit"',
        'import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"',
        "const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: '1m' })",
        "export default defineEventHandler(async (event) => {",
        '  if (!(await checkRateLimit(event, "og", { limit: 10, window: "1m" }))) return',
        '  if (await limiter.consume({ key: "a" })) return',
        '  await checkRateLimit(event, "og", { limit: 10, window: "1m" })',
        "})",
      ].join("\n"),
    })).toEqual(Array(3).fill("VHUB0008"))
  })

  it("accepts decisions that check allowed", async () => {
    expect(await codes(checkRateLimitDecision, {
      "server/api/og.get.ts": [
        'import { checkRateLimit } from "vite-hub/rate-limit"',
        "export default defineEventHandler(async (event) => {",
        '  const decision = await checkRateLimit(event, "og", { limit: 10, window: "1m" })',
        "  if (!decision.allowed) return",
        "})",
      ].join("\n"),
    })).toEqual([])
  })
})

describe("vitehub/rate-limiter-at-module-scope", () => {
  const perRequest = [
    'import { createRateLimiter } from "vite-hub/rate-limit"',
    'import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"',
    "export default defineEventHandler(async () => {",
    "  const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: '1m' })",
    '  return await limiter.consume({ key: "a" })',
    "})",
  ].join("\n")

  it("reports memory drivers created in a route handler", async () => {
    expect(await codes(rateLimiterAtModuleScope, { "server/api/a.get.ts": perRequest })).toEqual(["VHUB0009"])
  })

  it("accepts module-scope drivers, factories, and tests", async () => {
    expect(await codes(rateLimiterAtModuleScope, {
      "server/api/a.get.ts": [
        'import { createRateLimiter } from "vite-hub/rate-limit"',
        'import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"',
        "const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: '1m' })",
        "export function createLimiter() { return createRateLimiter({ driver: memoryRateLimitDriver(), limit: 1, window: '1s' }) }",
        'export default defineEventHandler(async () => await limiter.consume({ key: "a" }))',
      ].join("\n"),
      "server/api/a.test.ts": perRequest,
    })).toEqual([])
  })
})

describe("vitehub/auth-runtime-options", () => {
  it("reports runtime options in the static options object", async () => {
    expect(await codes(authRuntimeOptionsRule, {
      "server/auth.ts": 'import { defineAuth } from "vite-hub/auth"\nexport default defineAuth({ baseURL: "https://example.com", secret: secretValue, emailAndPassword: { enabled: true } })\n',
    })).toEqual(["VHUB0010", "VHUB0010"])
  })

  it("accepts runtime options from the callback", async () => {
    expect(await codes(authRuntimeOptionsRule, {
      "server/auth.ts": 'import { defineAuth } from "vite-hub/auth"\nexport default defineAuth(({ env, requestOrigin }) => ({ baseURL: requestOrigin, secret: env.auth.secret.unseal() }))\n',
    })).toEqual([])
  })
})

describe("vitehub/no-agent-connection-actor", () => {
  it("reports Agent actors", async () => {
    expect(await codes(noAgentConnectionActor, {
      "server/api/labels.get.ts": 'import { useConnection } from "vite-hub/connections/server"\nexport default defineEventHandler(() => useConnection("google", { actor: "agent:labeller" }))\n',
    })).toEqual(["VHUB0011"])
  })

  it("accepts server actors", async () => {
    expect(await codes(noAgentConnectionActor, {
      "server/api/labels.get.ts": 'import { useConnection } from "@vite-hub/connections/server"\nexport default defineEventHandler(() => useConnection("google", { actor: "schedule:gmail" }))\n',
    })).toEqual([])
  })
})

describe("vitehub/no-nested-blob-reference-schema", () => {
  it("reports Blob reference schemas inside Valibot objects", async () => {
    expect(await codes(noNestedBlobReferenceSchema, {
      "server/content.ts": [
        'import * as v from "valibot"',
        'import { strictObject } from "valibot"',
        'import { file, image } from "vite-hub/blob"',
        "export const post = v.object({ title: v.string(), cover: image() })",
        "export const upload = strictObject({ attachment: file({ maxSize: '5MB' }) })",
      ].join("\n"),
    })).toEqual(["VHUB0012", "VHUB0012"])
  })

  it("accepts reference schemas used directly", async () => {
    expect(await codes(noNestedBlobReferenceSchema, {
      "server/content.ts": [
        'import * as v from "valibot"',
        'import { image } from "vite-hub/blob"',
        "export const cover = image()",
        "export const post = v.object({ title: v.string(), cover: v.string() })",
        "export const check = (value: unknown) => cover['~standard'].validate(value)",
      ].join("\n"),
    })).toEqual([])
  })
})
