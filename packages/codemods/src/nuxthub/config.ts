import { end, findProperty, indentAt, keyName, line, quoteString, start } from "@vite-hub/internal/ast"

import { addViteHubOptions, ConfigEditor, createLineResolver, planHost, useViteHubModule } from "../shared/config-editor.ts"
import { findModuleEntry, literalValue, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { CodemodError } from "../types.ts"

import type { ObjectExpression } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { DefaultHost } from "../shared/config-editor.ts"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { FollowUp } from "../types.ts"
import type { RedisKVSource } from "./kv-env.ts"
import type { CloudflareResourceOptions } from "./wrangler.ts"

export const moduleName = "@nuxthub/core"

export type Dialect = "sqlite" | "postgresql"

/** The NuxtHub features that the app turns on, read from `hub`. */
export interface HubFeatures {
  database?: Dialect
  kv: boolean
  blob: boolean
  cache: boolean
}

/** A message about one `hub` option, placed on a `vitehub` key after the edit. */
interface ConfigNote {
  /** Path under `vitehub` in the edited config, such as `["kv"]`. */
  path: string[]
  message: string
}

/** NuxtHub's KV used Redis: `hub.kv` set the `redis` driver, or the app has a Redis variable that NuxtHub read on its own. */
type RedisKV =
  | { from: "driver", options: string, otherOptions: boolean }
  | { from: "env", source: RedisKVSource }

interface HubPlan {
  features: HubFeatures
  notes: ConfigNote[]
  bindings: FeatureBindings
  redisKV?: RedisKV
}

/** Only bindings proven by the original options may select an existing resource. */
export type FeatureBindings = Partial<Record<"database" | "kv" | "cache" | "blob", string>>

const featureKeys = ["kv", "blob", "cache"] as const

const droppedKeys: Record<string, string> = {
  dir: "hub.dir set the local data folder. ViteHub keeps local data in .vitehub/data/. Set dataDir under vitehub to keep another folder.",
  hosting: "hub.hosting chose the host. ViteHub reads vitehub.host instead.",
}

function optionText(config: NuxtConfigFile, node: Node): string {
  return config.code.slice(start(node), end(node)).replace(/\s+/g, " ")
}

function readDatabase(config: NuxtConfigFile, value: Node, notes: ConfigNote[]): Dialect | undefined {
  const literal = literalValue(value)
  if (literal === false) return undefined
  if (literal === true || literal === "sqlite") return "sqlite"
  if (literal === "postgresql") return "postgresql"
  if (literal === "mysql") throw new CodemodError("hub.db is \"mysql\". ViteHub does not support MySQL, so keep NuxtHub or Drizzle for this app.")
  const object = unwrapExpression(value)
  if (object.type !== "ObjectExpression") {
    notes.push({ path: ["database"], message: `hub.db is ${optionText(config, value)}, which the codemod cannot read. It set database: true for SQLite. Check the dialect and the connection.` })
    return "sqlite"
  }
  const dialectProperty = findProperty(object, "dialect")
  const dialect = dialectProperty ? readDatabase(config, dialectProperty.value, notes) : "sqlite"
  const others = object.properties.filter(property => property !== dialectProperty)
  if (others.length) {
    notes.push({ path: ["database"], message: `hub.db also set ${others.map(property => optionText(config, property)).join(", ")}. ViteHub reads the connection, the Cloudflare binding, and the Drizzle options from server/databases/default/index.ts. Move them there by hand. See https://vitehub.dev/docs/database/configure.` })
  }
  return dialect ?? "sqlite"
}

function featureNote(config: NuxtConfigFile, feature: (typeof featureKeys)[number], value: Node): ConfigNote {
  return { path: [feature], message: `hub.${feature} was ${optionText(config, value)}. The codemod set ${feature}: true, which uses the default driver of the host. NuxtHub and ViteHub name drivers differently, so set the driver options under vitehub.${feature} by hand. See https://vitehub.dev/docs/${feature === "cache" ? "getting-started/migrate-from-nuxthub#keep-the-cache" : feature}.` }
}

/** Reads `hub` into features. Options that do not map 1:1 become notes. */
export function readHub(config: NuxtConfigFile, redisSource?: RedisKVSource): HubPlan {
  const hubProperty = findProperty(config.root, "hub")
  const value = hubProperty ? unwrapExpression(hubProperty.value) : undefined
  if (value && value.type !== "ObjectExpression") {
    throw new CodemodError(`${config.fileName} sets hub to an expression. Make it an object literal, then run the codemod again.`)
  }
  const hub: ObjectExpression | undefined = value
  const features: HubFeatures = { kv: false, blob: false, cache: false }
  const bindings: FeatureBindings = { database: "DB" }
  const notes: ConfigNote[] = []
  let redisKV: RedisKV | undefined
  for (const property of hub?.properties ?? []) {
    if (property.type !== "ObjectProperty") {
      notes.push({ path: [], message: `hub has ${optionText(config, property)}, which the codemod cannot read. Move what it sets under vitehub by hand.` })
      continue
    }
    const key = keyName(property.key, property.computed)
    if (key === "db" || key === "database") {
      features.database = readDatabase(config, property.value, notes)
      continue
    }
    const feature = featureKeys.find(name => name === key)
    if (feature) {
      const literal = literalValue(property.value)
      if (literal === false) continue
      features[feature] = true
      const options = staticOptionsObject(property.value)
      if (literal === true) bindings[feature] = feature.toUpperCase()
      else if (options) {
        const binding = findProperty(options, "binding")
        const driver = findProperty(options, "driver")
        const expectedDriver = feature === "blob" ? "cloudflare-r2" : "cloudflare-kv-binding"
        if (!driver || literalValue(driver.value) === expectedDriver) {
          const value = binding ? literalValue(binding.value) : feature.toUpperCase()
          if (typeof value === "string" && value) bindings[feature] = value
        }
      }
      const kvDriver = feature === "kv" && options ? findProperty(options, "driver") : undefined
      if (options && kvDriver && literalValue(kvDriver.value) === "redis") {
        redisKV = { from: "driver", options: optionText(config, property.value), otherOptions: options.properties.length > 1 }
      }
      else if (feature === "kv" && literal === true && redisSource) redisKV = { from: "env", source: redisSource }
      else if (literal !== true) notes.push(featureNote(config, feature, property.value))
      continue
    }
    notes.push({ path: [], message: key && droppedKeys[key] ? `${droppedKeys[key]} The codemod dropped it.` : `hub.${key ?? optionText(config, property.key)} has no ViteHub option. The codemod dropped it.` })
  }
  return { features, notes, bindings, redisKV }
}

/** The `vitehub.kv` value and its note for NuxtHub's Redis KV. ViteHub selects Redis only from an explicit driver. */
function redisKVOption(redisKV: RedisKV, style: CodeStyle): { value: string, note?: ConfigNote } {
  const variable = redisKV.from === "env" ? redisKV.source.variable : "REDIS_URL"
  const value = `{ driver: ${quoteString("redis", style)}${variable === "KV_URL" ? `, url: ${quoteString("env:KV_URL", style)}` : ""} }`
  if (redisKV.from === "driver") {
    return redisKV.otherOptions
      ? { value, note: { path: ["kv"], message: `hub.kv was ${redisKV.options}. The codemod set kv: ${value}, which reads REDIS_URL at runtime. Move the other Redis options, such as url, under vitehub.kv by hand. See https://vitehub.dev/docs/kv/configure.` } }
      : { value }
  }
  return { value, note: { path: ["kv"], message: `${redisKV.source.file} has ${variable}, so NuxtHub kept KV in Redis. ViteHub does not select Redis on its own, so the codemod set kv: ${value}. If that Redis belongs to another service, such as BullMQ, set kv: true.` } }
}

/** Chooses the deployment host: nitro.preset, then a Wrangler config, then Node. */
function chooseHost(config: NuxtConfigFile, wranglerFile: string | undefined): { add?: string, note?: string, host?: string } {
  return planHost(config, wranglerFile ? { host: "cloudflare" } : undefined)
}

export interface ConfigEditResult {
  code: string
  host?: string
  followUps: FollowUp[]
  /** The Cloudflare resources that the new options keep. */
  written: CloudflareResourceOptions
  /** `vitehub.kv` selects Redis, so no local KV data moves. */
  redisKV: boolean
}

/** Replaces `@nuxthub/core` with `vite-hub/nuxt` and `hub` with `vitehub`. */
export function editConfig(config: NuxtConfigFile, plan: HubPlan, wranglerFile: string | undefined, resources: CloudflareResourceOptions = {}): ConfigEditResult {
  const entry = findModuleEntry(config, moduleName)
  if (entry?.inlineOptions) {
    throw new CodemodError(`${config.fileName} passes options to ${moduleName} in modules. Move them to the hub key, then run the codemod again.`)
  }
  const editor = new ConfigEditor(config)
  const style = editor.style
  const rootEntries = useViteHubModule(editor, config, moduleName)
  const hubProperty = findProperty(config.root, "hub")
  const { features } = plan
  const hostChoice = chooseHost(config, wranglerFile)
  // On Cloudflare, keep the namespaces and the bucket that the Wrangler config names. The IDs are not secrets.
  const written: CloudflareResourceOptions = {}
  const options: Array<[string, string]> = []
  const followUps: Array<{ path: string[], message: string }> = [...plan.notes]
  // Workers have no Redis TCP client, so the Cloudflare host keeps its KV binding.
  const redisKV = plan.redisKV && hostChoice.host !== "cloudflare" ? redisKVOption(plan.redisKV, style) : undefined
  if (redisKV?.note) followUps.push(redisKV.note)
  if (!redisKV && plan.redisKV?.from === "driver") {
    followUps.push({ path: ["kv"], message: `hub.kv was ${plan.redisKV.options}. The codemod set kv: true, which uses the default driver of the host. ViteHub Redis does not run on Cloudflare Workers, so check the KV driver. See https://vitehub.dev/docs/kv.` })
  }
  if (features.database) options.push(["database", "true"])
  for (const feature of featureKeys) {
    if (!features[feature]) continue
    if (feature === "kv" && redisKV) {
      options.push([feature, redisKV.value])
      continue
    }
    const resource = hostChoice.host === "cloudflare" ? resources[feature] : undefined
    if (resource) written[feature] = resource
    options.push([feature, resource ? `{ ${Object.entries(resource).map(([key, value]) => `${key}: ${quoteString(value, style)}`).join(", ")} }` : "true"])
  }
  const existingViteHub = findProperty(config.root, "vitehub")

  const hub = hubProperty ? unwrapExpression(hubProperty.value) : undefined
  if (hubProperty && hub?.type === "ObjectExpression" && !existingViteHub) {
    // Rename hub to vitehub in place, so the options keep their place in the file.
    const entries = [...(hostChoice.add ? [["host", quoteString(hostChoice.add, style)]] : []), ...options]
    const outer = indentAt(config.code, start(hubProperty))
    const inner = hub.properties[0] && config.code.slice(start(hub), start(hub.properties[0])).includes("\n") ? indentAt(config.code, start(hub.properties[0])) : `${outer}${style.indent}`
    const last = hub.properties.at(-1)
    const trailingComma = last ? /^\s*,/.test(config.code.slice(end(last), end(hub) - 1)) : true
    const body = entries.map(([key, value], index) => `${inner}${key}: ${value}${index < entries.length - 1 || trailingComma ? "," : ""}`).join("\n")
    editor.output.overwrite(start(hubProperty), end(hubProperty), entries.length ? `vitehub: {\n${body}\n${outer}}` : "vitehub: {}")
    if (hostChoice.note) followUps.push({ path: ["host"], message: hostChoice.note })
    if (rootEntries.length) editor.insertProperties(config.root, rootEntries, new Set())
  }
  else {
    const removed = new Set<Node>()
    if (hubProperty) {
      editor.removeItem(hubProperty)
      removed.add(hubProperty)
    }
    const defaultHost: DefaultHost | undefined = hostChoice.add ? { host: hostChoice.add, note: hostChoice.note } : undefined
    const result = addViteHubOptions(editor, config, {
      options: options.map(([key, value]) => ({ key, value: () => value, label: `the ${key} option` })),
      rootEntries,
      removedRootProperties: removed,
      defaultHost,
    })
    if (result.hostNote) followUps.push({ path: ["host"], message: result.hostNote })
  }
  const code = editor.output.toString()
  const lineOf = createLineResolver(code)
  return {
    code,
    host: hostChoice.host,
    written,
    redisKV: Boolean(redisKV),
    followUps: followUps.map(note => ({ file: config.fileName, line: lineOf(["vitehub", ...note.path]) ?? (hubProperty ? line(hubProperty) : undefined), message: note.message })),
  }
}
