import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { envSchema } from "@vite-hub/env/vite"
import { describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { planFromEnvFile, readEnvFileKeys } from "../src/nuxt-safe-runtime-config/env-file.ts"
import { looksSecret, nuxtVariableName } from "../src/nuxt-safe-runtime-config/fields.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

describe.each([
  ["valibot-schema", "an inline Valibot $schema"],
  ["zod-schema-module", "a Zod $schema module in a Nuxt 3 layout"],
  ["env-schema", "an envSchema .env.example in module options"],
])("nuxt-safe-runtime-config with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
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
