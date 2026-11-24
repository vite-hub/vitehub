import { isDeepStrictEqual } from "node:util"

import { features, impliedFeatures } from "@vite-hub/internal/features"
import { basename } from "pathe"

import { isRecord, readAddArgs, shellQuote } from "./add.ts"
import { isSetupFailure } from "./envelope.ts"

import type { JsonValue } from "@vite-hub/internal/config-edit"
import type { FeatureId } from "@vite-hub/internal/features"
import type { SetupProject } from "./project.ts"
import type { SetupStatus } from "./status.ts"

export interface SetupStack {
  command: string | null
  omits: readonly {
    path: string
    reason: "opaque-config" | "spread" | "expression" | "unresolved-host" | "unresolved-feature" | "disabled-feature" | "unsupported-feature" | "non-replayable-option" | "credential-option" | "required-option" | "unplannable-stack"
  }[]
}

function replayOption(id: FeatureId, keys: readonly string[], value: JsonValue): string | undefined {
  if (keys.some(key => !key || /[.=\0]/u.test(key) || ["__proto__", "constructor", "prototype"].includes(key))) return
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value)
  if (raw.includes("\0")) return
  const flag = `${id}.${keys.join(".")}=${raw}`
  try {
    const parsed = readAddArgs([id, "--option", flag]).options[id]
    const expected = keys.reduceRight<JsonValue>((child, key) => ({ [key]: child }), value)
    if (isDeepStrictEqual(parsed, expected)) return flag
  }
  catch {
    return
  }
}

function credentialKey(key: string): boolean {
  return /(?:token|secret|password|passphrase|apikey|privatekey|accesskey(?:id)?|connectionstring|credentials?|authorization|cookie|dsn)$/iu.test(key.replaceAll(/[-_]/gu, ""))
    || /^(?:pass|auth|headers)$/iu.test(key)
}

function containsCredentials(value: JsonValue): boolean {
  if (typeof value === "string") {
    const url = URL.parse(value.startsWith("//") ? `https:${value}` : value)
    return !!(url && (url.username || url.password || url.search || url.hash))
  }
  if (Array.isArray(value)) return value.some(containsCredentials)
  return isRecord(value) && Object.entries(value).some(([key, child]) => credentialKey(key) || containsCredentials(child))
}

export function setupStackLabels(stack: SetupStack): { command: string, omissions: string } {
  return {
    command: stack.command ?? "Unavailable",
    omissions: stack.omits.map(({ path, reason }) => `${path} (${reason})`).join(", "),
  }
}

export async function deriveSetupStack(project: SetupProject, status: SetupStatus, validate: (args: readonly string[]) => Promise<void>): Promise<SetupStack> {
  const site = project.config?.ok ? project.config.site : undefined
  const omits: SetupStack["omits"][number][] = []
  const options: string[] = []
  const selected: FeatureId[] = []

  const collect = (id: FeatureId, keys: string[], value: JsonValue): void => {
    const path = [id, ...keys].join(".")
    const mcpAccessMode = path === "mcp.auth" && keys.length === 1 && (typeof value === "boolean" || value === "optional")
    if (!mcpAccessMode && keys.some(credentialKey)) {
      omits.push({ path, reason: "credential-option" })
      return
    }
    if (isRecord(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) collect(id, [...keys, key], child)
      return
    }
    if (containsCredentials(value)) {
      omits.push({ path, reason: "credential-option" })
      return
    }
    const flag = keys.length ? replayOption(id, keys, value) : undefined
    if (flag === undefined) omits.push({ path, reason: "non-replayable-option" })
    else options.push(flag)
  }

  if (!site) omits.push({ path: "config", reason: "opaque-config" })
  if (site?.spread) omits.push({ path: "config", reason: "spread" })
  if (status.host.name === "unknown") omits.push({ path: "host", reason: "unresolved-host" })

  for (const { id, enabled, support } of status.features) {
    const setting = site?.keys[id]
    if (setting?.kind === "expression") {
      omits.push({ path: id, reason: "expression" })
      continue
    }
    if (enabled === "unknown" && site && !site.spread) omits.push({ path: id, reason: "unresolved-feature" })
    if (enabled !== "on") continue
    if (support.level === "unsupported") {
      omits.push({ path: id, reason: "unsupported-feature" })
      continue
    }
    const value = setting?.value
    if (features[id].enabledByDefault && (value === undefined || value === true || (isRecord(value) && !Object.keys(value).length))) continue
    selected.push(id)
    if (value !== undefined && value !== true) collect(id, [], value)
  }

  const implied = impliedFeatures(selected)
  for (const { id, enabled, reason } of status.features) {
    if (enabled === "off" && reason === "config" && (features[id].enabledByDefault || implied.includes(id))) {
      omits.push({ path: id, reason: "disabled-feature" })
    }
  }

  const name = basename(project.root)
  const dir = name.startsWith("-") ? `./${name}` : name || "vitehub-app"
  const args = [
    dir,
    "--host", status.host.name === "unknown" ? "<host>" : status.host.name,
    "--features", selected.join(","),
    ...options.flatMap(option => ["--option", option]),
    "--framework", status.framework === "nuxt" ? "nuxt" : "vite",
    "--pm", status.packageManager,
    "--yes",
  ]
  if (status.host.name !== "unknown") {
    try {
      await validate(args)
    }
    catch (error: unknown) {
      if (!isSetupFailure(error)) throw error
      const missing = error.details.missing
      if (missing?.length) omits.push(...missing.map(({ field }) => ({ path: field, reason: "required-option" as const })))
      else omits.push({ path: "features", reason: "unplannable-stack" })
      return { command: null, omits }
    }
  }
  return { command: ["pnpm", "dlx", "vite-hub", "init", ...args.map(shellQuote)].join(" "), omits }
}
