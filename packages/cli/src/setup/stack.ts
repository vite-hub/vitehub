import { isDeepStrictEqual } from "node:util"

import { features, impliedFeatures } from "@vite-hub/internal/features"
import { basename } from "pathe"

import { isRecord, readAddArgs, shellQuote } from "./add.ts"

import type { JsonValue } from "@vite-hub/internal/config-edit"
import type { FeatureId } from "@vite-hub/internal/features"
import type { SetupProject } from "./project.ts"
import type { SetupStatus } from "./status.ts"

export interface SetupStack {
  command: string
  omits: readonly {
    path: string
    reason: "opaque-config" | "spread" | "expression" | "unresolved-host" | "unresolved-feature" | "disabled-feature" | "unsupported-feature" | "non-replayable-option"
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

export function deriveSetupStack(project: SetupProject, status: SetupStatus): SetupStack {
  const site = project.config?.ok ? project.config.site : undefined
  const omits: SetupStack["omits"][number][] = []
  const options: string[] = []
  const selected: FeatureId[] = []

  const collect = (id: FeatureId, keys: string[], value: JsonValue): void => {
    if (isRecord(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) collect(id, [...keys, key], child)
      return
    }
    const flag = keys.length ? replayOption(id, keys, value) : undefined
    if (flag === undefined) omits.push({ path: [id, ...keys].join("."), reason: "non-replayable-option" })
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
    "pnpm", "dlx", "vite-hub", "init", dir,
    "--host", status.host.name === "unknown" ? "<host>" : status.host.name,
    "--features", selected.join(","),
    ...options.flatMap(option => ["--option", option]),
    "--framework", status.framework === "nuxt" ? "nuxt" : "vite",
    "--pm", status.packageManager,
    "--yes",
  ]
  return { command: args.map(shellQuote).join(" "), omits }
}
