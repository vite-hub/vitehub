import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

import { env, SecretEnv } from "@vite-hub/env"
import { bindServerEnvSchemas, resolveServerEnv } from "@vite-hub/env/server"
import { createRuntimeEnvRegistry, envSchema } from "@vite-hub/env/vite"
import { end, parseProgram, start } from "@vite-hub/internal/ast"
import * as v from "valibot"
import { z } from "zod"
import { z as z3 } from "zod/v3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { formatReport, runCli, runCodemod } from "../src/index.ts"
import { planFromEnvFile, readEnvFileKeys } from "../src/nuxt-safe-runtime-config/env-file.ts"
import { fieldAccess, runSteps } from "../src/nuxt-safe-runtime-config/field-schema.ts"
import { looksSecret, nuxtVariableName } from "../src/nuxt-safe-runtime-config/fields.ts"
import { planFromJsonSchema, schemaIssues, schemaToJsonSchema } from "../src/nuxt-safe-runtime-config/schema.ts"
import valibotModuleSchema from "./fixtures/valibot-schema-module/input/schema.ts"
import { withVersionPlaceholder } from "./fixture-version.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

function isStandardSchema(value: unknown): value is { "~standard": { validate: (input: unknown) => unknown } } {
  return typeof value === "object" && value !== null && "~standard" in value
}

describe.each([
  ["valibot-schema", "an inline Valibot $schema"],
  ["valibot-schema-module", "a Valibot $schema module with rules on the defaults"],
  ["zod-schema-module", "a Zod $schema module in a Nuxt 3 layout"],
  ["zod3-schema-module", "a Zod 3 $schema module"],
  ["env-schema", "an envSchema .env.example in module options"],
  ["valibot-transform", "a Valibot $schema module with transforms and checks"],
])("nuxt-safe-runtime-config with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before === undefined) expect(existsSync(join(input, edit.path))).toBe(false)
      else expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(withVersionPlaceholder(edit.after)).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

describe("nuxt-safe-runtime-config on a Nitro 2 app", () => {
  it("stops with CODEMODS_NITRO_UNSUPPORTED and writes nothing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-nsrc-nitro2-"))
    try {
      await cp(join(fixtures, "nitro2-module/input"), cwd, { recursive: true })
      const before = await Promise.all(["nitro.config.ts", "package.json"].map(file => readFile(join(cwd, file), "utf8")))
      let stdout = ""
      let stderr = ""
      const code = await runCli(["nuxt-safe-runtime-config", cwd], { stdout: text => stdout += text, stderr: text => stderr += text })
      expect(code).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain("nitro.config.ts belongs to a Nitro 2 app: package.json requires nitropack \"^2.13.0\".")
      expect(stderr).toContain("Fix: Keep nuxt-safe-runtime-config/nitro while the app runs on Nitro 2.")
      await expect(runCodemod("nuxt-safe-runtime-config", { cwd })).rejects.toMatchObject({ code: "CODEMODS_NITRO_UNSUPPORTED" })
      let report = ""
      expect(await runCli([cwd], { stdout: text => report += text, stderr: () => {} })).toBe(1)
      expect(report).toContain("Not migrated: nitro.config.ts belongs to a Nitro 2 app")
      expect((await readdir(cwd)).sort()).toEqual(["nitro.config.ts", "package.json"])
      expect(await Promise.all(["nitro.config.ts", "package.json"].map(file => readFile(join(cwd, file), "utf8")))).toEqual(before)
    }
    finally {
      await rm(cwd, { recursive: true, force: true })
    }
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
    const config: { vitehub: { env: { server: Parameters<typeof createRuntimeEnvRegistry>[0] } } } = runInNewContext(code.slice(start(exported.declaration), end(exported.declaration)), { defineNuxtConfig: (options: unknown) => options, env, publicApiBase: v.string() })
    return { ...config.vitehub.env.server }
  }

  async function migrateSchemaConfig(config: string, schema: string, dependencies: Record<string, string> = { "nuxt-safe-runtime-config": "0.3.2" }, installed?: string) {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-defaults-"))
    try {
      await Promise.all([
        writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies })),
        writeFile(join(cwd, "nuxt.config.ts"), config),
        writeFile(join(cwd, "schema.ts"), `import * as v from ${JSON.stringify(fileURLToPath(import.meta.resolve("valibot")))}\nexport default ${schema}`),
      ])
      if (installed) {
        await mkdir(join(cwd, "node_modules/nuxt-safe-runtime-config"), { recursive: true })
        await writeFile(join(cwd, "node_modules/nuxt-safe-runtime-config/package.json"), JSON.stringify({ name: "nuxt-safe-runtime-config", version: installed }))
      }
      const run = await runCodemod("nuxt-safe-runtime-config", { cwd, dryRun: true })
      return { code: run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after ?? "", report: formatReport(run) }
    }
    finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  it("keeps runtime-coerced defaults and passes strings to string-input transforms", async () => {
    const { code } = await migrateSchemaConfig(`export default defineNuxtConfig({
      modules: ['nuxt-safe-runtime-config'],
      safeRuntimeConfig: { $schema: './schema', validateAtRuntime: true },
      runtimeConfig: { retryCount: process.env.COUNT ?? '3', featureEnabled: 'false', port: '3000' },
    })`, "v.object({ retryCount: v.number(), featureEnabled: v.boolean(), port: v.pipe(v.string(), v.transform(Number), v.number()) })")
    expect(code).toContain("port: env({ default: '3000', schema: env.schemaFrom('./server/env.schema.ts', 'port'), source: env.source('NUXT_PORT') })")
    for (const name of ["COUNT", "NUXT_RETRY_COUNT", "VITEHUB_RETRY_COUNT", "NUXT_FEATURE_ENABLED", "VITEHUB_FEATURE_ENABLED", "NUXT_PORT", "VITEHUB_PORT"]) vi.stubEnv(name, undefined)
    const registry = createRuntimeEnvRegistry(migratedServerEnv(code), { path: "env.server", prefix: false, schemaModules: true })
    bindServerEnvSchemas(registry, { "./server/env.schema.ts": { port: v.pipe(v.string(), v.transform(Number), v.number()) } })
    expect(resolveServerEnv(registry)).toMatchObject({ retryCount: 3, featureEnabled: false, port: 3000 })
  })

  it.each([
    ["top-level warn", "'nuxt-safe-runtime-config'", "onError: 'warn'"],
    ["tuple ignore overriding throw", "['nuxt-safe-runtime-config', { onError: 'ignore' }]", "onError: 'throw'"],
  ])("keeps defaults under %s", async (_label, moduleEntry, options) => {
    const { code, report } = await migrateSchemaConfig(`export default defineNuxtConfig({
      modules: [${moduleEntry}],
      safeRuntimeConfig: { $schema: './schema', validateAtRuntime: true, ${options} },
      runtimeConfig: { region: 'x', apiSecret: 'x' },
    })`, "v.object({ region: v.pipe(v.string(), v.minLength(3)), apiSecret: v.pipe(v.string(), v.minLength(3)) })")
    expect(code).toContain("region: env({ default: 'x', source: env.source('NUXT_REGION') })")
    expect(code).toContain("apiSecret: env({ secret: true, source: env.source('NUXT_API_SECRET') })")
    expect(report).not.toContain("which its $schema rejects")
    expect(report).toContain("Env stops the app when a schema fails, so the codemod wrote no schema module.")
  })

  const buildCheckOff = `export default defineNuxtConfig({
      modules: ['nuxt-safe-runtime-config'],
      safeRuntimeConfig: { $schema: './schema', validateAtBuild: false },
      runtimeConfig: { apiSecret: '' },
    })`
  const secretSchema = "v.object({ apiSecret: v.pipe(v.string(), v.minLength(16)) })"

  it.each([
    ["0.4.0", { "nuxt-safe-runtime-config": "0.4.0" }, undefined],
    ["^0.4.0", { "nuxt-safe-runtime-config": "^0.4.0" }, undefined],
    ["an unreadable range", { "nuxt-safe-runtime-config": "catalog:" }, undefined],
    ["no declared version", {}, undefined],
    ["installed 0.4.0", { "nuxt-safe-runtime-config": "^0.3.2 || ^0.4.0" }, "0.4.0"],
  ])("requires a variable that module %s checks when the server starts with validateAtBuild: false", async (_label, dependencies, installed) => {
    const { code, report } = await migrateSchemaConfig(buildCheckOff, secretSchema, dependencies, installed)
    expect(code).toContain("apiSecret: env({ schema: env.schemaFrom('./server/env.schema.ts', 'apiSecret'), secret: true, source: env.source('NUXT_API_SECRET') })")
    expect(report).toContain("which its $schema rejects")
  })

  it.each([
    ["0.3.2", { "nuxt-safe-runtime-config": "0.3.2" }, undefined],
    ["^0.3.2", { "nuxt-safe-runtime-config": "^0.3.2" }, undefined],
    ["installed 0.3.2", { "nuxt-safe-runtime-config": "^0.3.2 || ^0.4.0" }, "0.3.2"],
  ])("keeps a default that module %s never checked with validateAtBuild: false", async (_label, dependencies, installed) => {
    const { code, report } = await migrateSchemaConfig(buildCheckOff, secretSchema, dependencies, installed)
    expect(code).toContain("apiSecret: env({ default: '', secret: true, source: env.source('NUXT_API_SECRET') })")
    expect(report).not.toContain("which its $schema rejects")
    expect(report).toContain("The module did not validate runtimeConfig, so the codemod wrote no schema module.")
  })

  it("requires a variable whose empty default failed the schema at boot", async () => {
    const input = join(fixtures, "valibot-schema-module/input")
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd: input, dryRun: true })
    const code = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after ?? ""
    expect(code).toContain("apiSecret: env({ schema: env.schemaFrom('./server/env.schema.ts', 'apiSecret'), secret: true, source: env.source('NUXT_API_SECRET') })")
    expect(code).toContain("webhookSecret: env({ default: '', secret: true, source: env.source('NUXT_WEBHOOK_SECRET') })")
    const server = migratedServerEnv(code)
    const registry = () => {
      const created = createRuntimeEnvRegistry(server, { path: "env.server", prefix: false, schemaModules: true })
      bindServerEnvSchemas(created, { "./server/env.schema.ts": valibotModuleSchema.entries })
      return created
    }

    vi.stubEnv("NUXT_API_SECRET", undefined)
    vi.stubEnv("VITEHUB_API_SECRET", undefined)
    vi.stubEnv("NUXT_WEBHOOK_SECRET", undefined)
    vi.stubEnv("VITEHUB_WEBHOOK_SECRET", undefined)
    vi.stubEnv("NUXT_ALLOWED_ORIGINS", undefined)
    vi.stubEnv("VITEHUB_ALLOWED_ORIGINS", undefined)
    vi.stubEnv("NUXT_PORT", undefined)
    vi.stubEnv("VITEHUB_PORT", undefined)
    expect(() => resolveServerEnv(registry())).toThrow(expect.objectContaining({ code: "ENV_REQUIRED_MISSING", message: expect.stringContaining("NUXT_API_SECRET") }))

    vi.stubEnv("NUXT_API_SECRET", "0123456789abcdef")
    const resolved = resolveServerEnv(registry())
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
    ["Valibot", v.object({ group: v.lazy(() => v.object({ region: v.pipe(v.string(), v.check(value => value !== "none")) })) })],
    ["Zod", z.object({ group: z.lazy(() => z.object({ region: z.string().refine(value => value !== "none") })) })],
  ])("checks child defaults within a lazy %s object", async (_label, schema) => {
    const plan = await planned(schema, "group.region", "none")
    expect(plan.fields[0]).toMatchObject({ configPath: ["group", "region"], required: true })
    expect(plan.fields[0]).not.toHaveProperty("default")
  })

  it.each([
    ["Valibot", v.object({ group: v.lazy(() => v.object({ region: v.pipe(v.string(), v.check(value => value !== "none")) })) }), [".entries", ".group", ".getter()", ".entries", ".region"]],
    ["Zod", z.object({ group: z.lazy(() => z.object({ region: z.string().refine(value => value !== "none") })) }), [".shape", ".group", ".unwrap()", ".shape", ".region"]],
  ])("exports a field within a lazy %s object", async (_label, schema, expected) => {
    const access = fieldAccess(schema, ["group", "region"])
    expect(access?.steps.map(step => step.kind === "call" ? `.${step.name}()` : `.${step.name}`)).toEqual(expected)
    const exported = runSteps(schema, access?.steps ?? [])
    if (!isStandardSchema(exported)) throw new Error("The steps did not return a schema")
    expect(await exported["~standard"].validate("none")).toHaveProperty("issues")
    expect(await exported["~standard"].validate("eu")).toMatchObject({ value: "eu" })
    expect(await exported["~standard"].validate("eu")).not.toHaveProperty("issues")
  })

  it.each([
    [{ type: "string", minLength: 16 }, ""],
    [{ type: "string", pattern: "^sk_" }, "pk_1"],
    [{ type: "string", format: "uri" }, "not a url"],
    [{ type: "string", format: "email" }, ""],
    [{ type: "number", minimum: 1 }, 0],
    [{ type: "integer" }, 1.5],
    [{ type: "number", multipleOf: 0.1 }, 0.35],
  ])("falls back to the JSON Schema rules %j without a field schema", async (node, value) => {
    const plan = await planFromJsonSchema({
      jsonSchema: { type: "object", required: ["value"], properties: { value: node } },
      issues: new Map(),
      runtimeConfig: new Map([["value", { literal: value }]]),
    })
    expect(plan.fields[0]).not.toHaveProperty("default")
    expect(plan.fields[0]?.required).toBe(true)
  })

  it.each([[0.3, 0.1], [-3e-8, 1e-8]])("keeps %s as a decimal multiple of %s", async (value, multipleOf) => {
    const plan = await planFromJsonSchema({
      jsonSchema: { type: "object", required: ["value"], properties: { value: { type: "number", multipleOf } } },
      issues: new Map(),
      runtimeConfig: new Map([["value", { literal: value }]]),
    })
    expect(plan.fields[0]?.default).toBe(value)
  })
})
