import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

import { env, SecretEnv } from "@vite-hub/env"
import { resolveServerEnv } from "@vite-hub/env/server"
import { createRuntimeEnvRegistry, envSchema } from "@vite-hub/env/vite"
import { end, parseProgram, start } from "@vite-hub/internal/ast"
import * as v from "valibot"
import { z } from "zod"
import { z as z3 } from "zod/v3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { planFromEnvFile, readEnvFileKeys } from "../src/nuxt-safe-runtime-config/env-file.ts"
import { looksSecret, nuxtVariableName } from "../src/nuxt-safe-runtime-config/fields.ts"
import { planFromJsonSchema, schemaIssues, schemaToJsonSchema } from "../src/nuxt-safe-runtime-config/schema.ts"
import { withVersionPlaceholder } from "./fixture-version.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

describe.each([
  ["valibot-schema", "an inline Valibot $schema"],
  ["valibot-schema-module", "a Valibot $schema module with rules on the defaults"],
  ["zod-schema-module", "a Zod $schema module in a Nuxt 3 layout"],
  ["env-schema", "an envSchema .env.example in module options"],
])("nuxt-safe-runtime-config with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(withVersionPlaceholder(edit.after)).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

function declarationAt(config: unknown, path: readonly string[]): unknown {
  let current = config
  for (const segment of path) {
    current = typeof current === "object" && current !== null ? Object.getOwnPropertyDescriptor(current, segment)?.value : undefined
  }
  return current
}

describe("envSchema mapping", () => {
  it("reads the same NUXT_ names at the same paths as the Nuxt module", async () => {
    const file = join(fixtures, "env-schema/input/.env.example")
    const nuxtPaths = {
      NUXT_DATABASE_URL: "database.url",
      NUXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE: "public.posthog.replaySampleRate",
    }
    const plan = planFromEnvFile(readEnvFileKeys(await readFile(file, "utf8")), nuxtPaths, ".env.example")
    const config = envSchema(file, { prefix: "NUXT_", paths: plan.paths })

    expect(plan.paths).toEqual({ NUXT_DATABASE_URL: "database.url" })
    expect(Object.keys(config.public ?? {}).sort()).toEqual(plan.fields.filter(field => field.section === "public").map(field => field.envPath[0]).sort())
    for (const field of plan.fields) {
      expect(declarationAt(field.section === "public" ? config.public : config.server, field.envPath), field.variable).toMatchObject({
        kind: "env-variable",
        mode: field.section === "public" ? "build" : "runtime",
        secret: field.secret,
        source: { kind: "env", name: field.variable, canonical: false },
      })
      // Nuxt maps NUXT_ and the upper snake case path, so unmapped keys keep the same path.
      if (!(field.variable in nuxtPaths)) {
        expect(nuxtVariableName(field.section, field.configPath)).toBe(field.variable)
        expect(field.envPath).toEqual(field.configPath)
      }
    }
    expect(declarationAt(config.public, ["posthogReplaySampleRate"])).toMatchObject({ source: { name: "NUXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE" } })
    expect(declarationAt(config.server, ["database", "url"])).toMatchObject({ source: { name: "NUXT_DATABASE_URL" } })
  })

  it("reads sensitivity from env-spec decorators", () => {
    expect(readEnvFileKeys([
      "# @public",
      "NUXT_PUBLIC_A=1",
      "# @sensitive=false",
      "NUXT_B=",
      "NUXT_C=",
      "# @type=object(enabled=boolean)",
      "NUXT_D='{",
      "\"enabled\": true",
      "}'",
      "NUXT_E= # @public",
    ].join("\n"))).toEqual([
      { key: "NUXT_PUBLIC_A", line: 2, sensitive: false },
      { key: "NUXT_B", line: 4, sensitive: false },
      { key: "NUXT_C", line: 5, sensitive: true },
      { key: "NUXT_D", line: 7, sensitive: true },
      { key: "NUXT_E", line: 10, sensitive: false },
    ])
  })
})

describe("names", () => {
  it("follows the Nuxt NUXT_ rule", () => {
    expect(nuxtVariableName("server", ["apiSecret"])).toBe("NUXT_API_SECRET")
    expect(nuxtVariableName("server", ["stripe", "secretKey"])).toBe("NUXT_STRIPE_SECRET_KEY")
    expect(nuxtVariableName("public", ["posthog", "sampleRate"])).toBe("NUXT_PUBLIC_POSTHOG_SAMPLE_RATE")
    expect(nuxtVariableName("server", ["s3Bucket"])).toBe("NUXT_S3_BUCKET")
  })

  it("marks credential-like names as secret", () => {
    for (const path of [["apiSecret"], ["githubToken"], ["sessionPassword"], ["stripe", "key"], ["sentryDsn"], ["databaseUrl"], ["redis", "url"], ["credentials"]]) {
      expect(looksSecret(path), path.join(".")).toBe(true)
    }
    for (const path of [["apiBase"], ["maxRetries"], ["siteUrl"], ["region"], ["keyboardLayout"]]) {
      expect(looksSecret(path), path.join(".")).toBe(false)
    }
  })
})

describe("defaults that the field schema rejects", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function migratedServerEnv(code: string) {
    const exported = parseProgram(code).program.body.find(node => node.type === "ExportDefaultDeclaration")
    if (exported?.type !== "ExportDefaultDeclaration") throw new Error("Missing migrated config")
    const config: { vitehub: { env: { server: Parameters<typeof createRuntimeEnvRegistry>[0] } } } = runInNewContext(code.slice(start(exported.declaration), end(exported.declaration)), { defineNuxtConfig: (options: unknown) => options, env })
    return { ...config.vitehub.env.server }
  }

  it("requires a variable whose empty default failed the schema at boot", async () => {
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd: join(fixtures, "valibot-schema-module/input"), dryRun: true })
    const code = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after ?? ""
    expect(code).toContain("apiSecret: env({ secret: true, source: env.source('NUXT_API_SECRET') })")
    expect(code).toContain("webhookSecret: env({ default: '', secret: true, source: env.source('NUXT_WEBHOOK_SECRET') })")
    const server = migratedServerEnv(code)

    vi.stubEnv("NUXT_API_SECRET", undefined)
    vi.stubEnv("VITEHUB_API_SECRET", undefined)
    vi.stubEnv("NUXT_WEBHOOK_SECRET", undefined)
    vi.stubEnv("VITEHUB_WEBHOOK_SECRET", undefined)
    expect(() => resolveServerEnv(createRuntimeEnvRegistry(server, { prefix: false }))).toThrow(expect.objectContaining({ code: "ENV_REQUIRED_MISSING", message: expect.stringContaining("NUXT_API_SECRET") }))

    vi.stubEnv("NUXT_API_SECRET", "0123456789abcdef")
    const resolved = resolveServerEnv(createRuntimeEnvRegistry(server, { prefix: false }))
    expect(resolved.apiSecret).toBeInstanceOf(SecretEnv)
    expect(resolved.webhookSecret instanceof SecretEnv ? resolved.webhookSecret.unseal() : resolved.webhookSecret).toBe("")
  })

  async function planned(schema: unknown, key: string, value: string) {
    return planFromJsonSchema({ schema, jsonSchema: await schemaToJsonSchema(schema), issues: schemaIssues(schema), runtimeConfig: new Map([[key, { literal: value }]]) })
  }

  it.each([
    ["Valibot minLength", v.object({ apiSecret: v.pipe(v.string(), v.minLength(16)) }), "apiSecret", ""],
    ["Valibot url", v.object({ siteUrl: v.pipe(v.string(), v.url()) }), "siteUrl", ""],
    ["Valibot custom check", v.object({ siteUrl: v.pipe(v.string(), v.check(value => value.startsWith("https://"))) }), "siteUrl", "http://example.com"],
    ["optional Valibot email", v.object({ contact: v.optional(v.pipe(v.string(), v.email())) }), "contact", ""],
    ["Zod min", z.object({ apiSecret: z.string().min(16) }), "apiSecret", ""],
    ["Zod refine", z.object({ region: z.string().refine(value => value !== "none") }), "region", "none"],
    ["Zod 3 regex", z3.object({ region: z3.string().regex(/^[a-z]+-\d$/) }), "region", "eu"],
  ])("drops a %s default and requires the variable", async (_label, schema, key, value) => {
    const plan = await planned(schema, key, value)
    expect(plan.fields[0]).toMatchObject({ configPath: [key], required: true })
    expect(plan.fields[0]).not.toHaveProperty("default")
    expect(plan.followUps.map(entry => entry.message)).toContainEqual(expect.stringContaining(`which its $schema rejects`))
  })

  it.each([
    ["Valibot string", v.object({ apiSecret: v.string() }), "apiSecret", ""],
    ["Valibot minLength", v.object({ title: v.pipe(v.string(), v.minLength(3)) }), "title", "Docs"],
    ["Zod string", z.object({ apiSecret: z.string() }), "apiSecret", ""],
    ["Zod 3 string", z3.object({ apiSecret: z3.string() }), "apiSecret", ""],
  ])("keeps a %s default that the schema accepts", async (_label, schema, key, value) => {
    const plan = await planned(schema, key, value)
    expect(plan.fields[0]).toMatchObject({ configPath: [key], default: value })
  })

  it("checks nested and public fields against their own schema", async () => {
    const schema = v.object({
      stripe: v.object({ secretKey: v.pipe(v.string(), v.startsWith("sk_")) }),
      public: v.object({ apiBase: v.pipe(v.string(), v.url()) }),
    })
    const plan = await planFromJsonSchema({
      schema,
      jsonSchema: await schemaToJsonSchema(schema),
      issues: schemaIssues(schema),
      runtimeConfig: new Map([["stripe.secretKey", { literal: "" }], ["public.apiBase", { literal: "/api" }]]),
    })
    expect(plan.fields.map(field => [field.section, field.envPath.join("."), field.default])).toEqual([
      ["server", "stripe.secretKey", undefined],
      ["public", "apiBase", undefined],
    ])
  })

  it.each([
    [{ type: "string", minLength: 16 }, ""],
    [{ type: "string", pattern: "^sk_" }, "pk_1"],
    [{ type: "string", format: "uri" }, "not a url"],
    [{ type: "string", format: "email" }, ""],
    [{ type: "number", minimum: 1 }, 0],
    [{ type: "integer" }, 1.5],
  ])("falls back to the JSON Schema rules %j without a field schema", async (node, value) => {
    const plan = await planFromJsonSchema({
      jsonSchema: { type: "object", required: ["value"], properties: { value: node } },
      issues: new Map(),
      runtimeConfig: new Map([["value", { literal: value }]]),
    })
    expect(plan.fields[0]).not.toHaveProperty("default")
    expect(plan.fields[0]?.required).toBe(true)
  })
})
