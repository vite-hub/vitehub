import { camelCase } from "scule"

import { looksSecret } from "../nuxt-safe-runtime-config/fields.ts"
import { coerceDefault, constraintNotes, describeLeaf, schemaIssues, schemaToJsonSchema } from "../nuxt-safe-runtime-config/schema.ts"
import { CodemodError } from "../types.ts"
import { isRecord } from "@vite-hub/internal/object"

import type { EnvField, LiteralValue } from "../nuxt-safe-runtime-config/fields.ts"
import type { T3EnvOptions } from "./load.ts"

/** One `createEnv()` key and its Env declaration. */
export interface T3Field {
  /** The variable name, such as `DATABASE_URL`. */
  key: string
  /** The `createEnv()` section that declared it. */
  section: "client" | "server" | "shared"
  field: EnvField
}

export interface T3Plan {
  fields: T3Field[]
  /** Messages about one key, with the key they belong to. */
  followUps: Array<{ key?: string, message: string }>
}

/** Runs the schema on a missing value: optional schemas pass, and a schema with a default returns it. */
async function validateMissing(schema: unknown): Promise<{ passes: boolean, value?: unknown }> {
  const standard = isRecord(schema) ? schema["~standard"] : undefined
  const validate = isRecord(standard) ? standard.validate : undefined
  if (typeof validate !== "function") return { passes: false }
  try {
    const result: unknown = await Reflect.apply(validate, standard, [undefined])
    if (isRecord(result) && Array.isArray(result.issues) && result.issues.length) return { passes: false }
    return { passes: true, value: isRecord(result) ? result.value : undefined }
  }
  catch {
    return { passes: false }
  }
}

function isLiteral(value: unknown): value is LiteralValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

/** The Env name of a variable: `DATABASE_URL` is `databaseUrl`, and `NUXT_PUBLIC_SITE_URL` is `siteUrl`. */
export function envPathOf(key: string, section: EnvField["section"]): string {
  const name = section === "public" ? key.replace(/^NUXT_PUBLIC_/, "") : key.replace(/^NUXT_/, "")
  return camelCase(name.toLowerCase())
}

/** Plans one Env declaration for each `createEnv()` key. */
export async function planT3Env(options: T3EnvOptions, cwd: string): Promise<T3Plan> {
  // JSON Schema describes value shapes. Parser compatibility needs manual review for every schema,
  // including libraries and wrappers that schemaIssues() does not recognize.
  const plan: T3Plan = {
    fields: [],
    followUps: [{ message: 'Check every migrated variable with missing and invalid values before using the app. Env uses its own parsers; the original coercion, catch() fallbacks, refinements, and transforms are not preserved. For example, z.coerce.boolean() reads "false" as true, while env.boolean() returns false. Keep equivalent parsing and invalid-value fallback handling where code reads a value.' }],
  }
  const used = new Map<string, string>()
  const sections: Array<[T3Field["section"], Record<string, unknown>]> = [["server", options.server], ["shared", options.shared], ["client", options.client]]
  for (const [t3Section, entries] of sections) {
    for (const [key, schema] of Object.entries(entries)) {
      const follow = (message: string) => plan.followUps.push({ key, message })
      const section: EnvField["section"] = t3Section === "client" ? "public" : "server"
      if (section === "public" && !key.startsWith("NUXT_PUBLIC_")) {
        follow(`${key} is a client variable without the NUXT_PUBLIC_ prefix. It was not migrated. Rename it to NUXT_PUBLIC_${key} and declare it under vitehub.env.public.`)
        continue
      }
      const name = envPathOf(key, section)
      const taken = used.get(`${section}.${name}`)
      if (taken) {
        follow(`${key} and ${taken} both become ${section === "public" ? "usePublicEnv" : "useServerEnv"}().${name}. ${key} was not migrated. Declare it by hand under another name.`)
        continue
      }
      used.set(`${section}.${name}`, key)
      let jsonSchema: Record<string, unknown>
      try {
        jsonSchema = await schemaToJsonSchema(schema, cwd)
      }
      catch (error) {
        if (!(error instanceof CodemodError)) throw error
        follow(`${key}: ${error.message.replace("The $schema", "The schema")} It was declared as a plain string.`)
        jsonSchema = { type: "string" }
      }
      const leaf = describeLeaf(jsonSchema, jsonSchema)
      const missing = await validateMissing(schema)
      const field: EnvField = {
        section,
        configPath: [name],
        envPath: [name],
        variable: key,
        kind: "string",
        required: !missing.passes,
        secret: false,
      }
      if (leaf.nullable) follow(`${key} accepts null. Env has no null value. Check code that expects null after migrating.`)
      if (leaf.kind === "enum") {
        field.kind = "enum"
        field.values = leaf.values
      }
      else if (leaf.kind === "boolean" || leaf.kind === "number" || leaf.kind === "string") {
        field.kind = leaf.kind
      }
      else if (leaf.kind === "integer") {
        field.kind = "number"
      }
      else {
        const shape = leaf.kind === "union" ? "a union" : leaf.kind === "unknown" ? "a schema without a JSON Schema type" : `a JSON ${leaf.kind}`
        follow(`${key} is ${shape}, which Env cannot declare. It is declared as a string, so parse the value where code reads it.`)
      }
      field.secret = section === "server" && field.kind !== "enum" && looksSecret([key])
      const defaultValue = missing.passes && isLiteral(missing.value) ? coerceDefault(missing.value, field) : undefined
      if (defaultValue !== undefined && field.secret) {
        follow(`${key} is secret, so its default was not kept. Defaults are written into the server build. Set ${key} where the app runs.`)
      }
      else if (defaultValue !== undefined) {
        field.default = defaultValue
      }
      const issues = schemaIssues(schema).get("") ?? []
      // Env rejects an empty required value, so min(1) on a required string needs no follow-up.
      const constraints = [...constraintNotes(leaf).filter(note => !(note === "minimum length 1" && field.required)), ...issues]
      if (constraints.length) {
        follow(`${key}: Env does not keep ${constraints.join(", ")}. Check the value where code reads it, or use envSchema() with a .env.example for length, range, integer, and URL checks.`)
      }
      if (issues.some(issue => issue.includes("transform") || issue.includes("pipe"))) {
        follow(`${key} had a transform, so code received the transformed value. Env returns the parsed ${field.kind}. Check the code that reads it.`)
      }
      if (t3Section === "shared") {
        follow(`${key} was a shared variable. It is Server Env now. Declare a Public Env value too if app code reads it.`)
      }
      plan.fields.push({ key, section: t3Section, field })
    }
  }
  return plan
}
