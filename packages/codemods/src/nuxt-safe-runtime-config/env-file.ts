import { camelCase } from "scule"

import { CodemodError } from "../types.ts"

import type { EnvField, PlannedFollowUp } from "./fields.ts"

export interface EnvFileKey {
  key: string
  line: number
  sensitive: boolean
}

/**
 * Reads the keys and sensitivity of an env-spec `.env.example`. The build validates the whole file with `envSchema()`;
 * the codemod needs only names and sensitivity to rewrite call sites.
 */
export function readEnvFileKeys(source: string): EnvFileKey[] {
  const keys: EnvFileKey[] = []
  let comments: string[] = []
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index] ?? ""
    const trimmed = text.trim()
    if (trimmed.startsWith("#")) {
      comments.push(trimmed)
      continue
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed)
    if (!match?.[1]) {
      comments = []
      continue
    }
    const decorators = [...comments, match[2] ?? ""].join(" ")
    const publicMark = /@public(?:=(true|false))?\b/.exec(decorators)
    const sensitiveMark = /@sensitive(?:=(true|false))?\b/.exec(decorators)
    const sensitive = publicMark ? publicMark[1] === "false" : sensitiveMark ? sensitiveMark[1] !== "false" : true
    keys.push({ key: match[1], line: index + 1, sensitive })
    comments = []
    // A quoted value can span lines. Skip to its closing quote.
    const value = (match[2] ?? "").trim()
    const quote = value[0]
    if ((quote === "'" || quote === "\"" || quote === "`") && !value.slice(1).includes(quote)) {
      while (index + 1 < lines.length && !(lines[index + 1] ?? "").includes(quote)) index++
      index++
    }
  }
  return keys
}

/** The output name rule of `envSchema()` in `@vite-hub/env`. */
function envOutputName(name: string): string {
  return name.split("_").filter(Boolean).map((word, index) => {
    const normalized = word === word.toUpperCase() ? word.toLowerCase() : word
    return index === 0 ? normalized.charAt(0).toLowerCase() + normalized.slice(1) : normalized.charAt(0).toUpperCase() + normalized.slice(1)
  }).join("")
}

export interface EnvSchemaPlan {
  fields: EnvField[]
  /** Server paths for the `envSchema()` `paths` option. */
  paths: Record<string, string>
  followUps: PlannedFollowUp[]
}

/**
 * Maps the Nuxt module's paths to Env paths. With `prefix: "NUXT_"`, Env strips `NUXT_` or `NUXT_PUBLIC_` and uses
 * camel case, which is the Nuxt mapping for flat keys. Server `paths` stay the same. Public Env is flat, so a nested
 * public path falls back to the flat name.
 */
export function planFromEnvFile(keys: readonly EnvFileKey[], nuxtPaths: Record<string, string>, file: string): EnvSchemaPlan {
  const plan: EnvSchemaPlan = { fields: [], paths: {}, followUps: [] }
  for (const entry of keys) {
    if (!entry.key.startsWith("NUXT_")) {
      throw new CodemodError(`${file}:${entry.line} (${entry.key}): the Nuxt module accepts only NUXT_ keys. Fix the file before you migrate.`)
    }
    const publicKey = entry.key.startsWith("NUXT_PUBLIC_")
    const bareName = entry.key.slice(publicKey ? "NUXT_PUBLIC_".length : "NUXT_".length)
    const name = envOutputName(bareName)
    const nuxtPath = nuxtPaths[entry.key]
    const configPath = nuxtPath ? nuxtPath.split(".").slice(publicKey ? 1 : 0) : [camelCase(bareName, { normalize: true })]
    let envPath = nuxtPath ? configPath : [name]
    if (publicKey) {
      envPath = [name]
      if (nuxtPath) {
        plan.followUps.push({ message: `${entry.key} was mapped to ${nuxtPath}. Public Env is flat, so read it as usePublicEnv().${name}.`, anchor: { file, line: entry.line } })
      }
    }
    else if (nuxtPath) {
      plan.paths[entry.key] = nuxtPath
    }
    plan.fields.push({
      section: publicKey ? "public" : "server",
      configPath,
      envPath,
      variable: entry.key,
      kind: "string",
      required: true,
      secret: !publicKey && entry.sensitive,
    })
  }
  return plan
}
