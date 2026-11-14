import { end, findProperty, indentAt, keyName, line, quoteString, start } from "@vite-hub/internal/ast"

import { addViteHubOptions, ConfigEditor, createLineResolver, planHost, useViteHubModule } from "../shared/config-editor.ts"
import { findModuleEntry, literalValue, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { CodemodError } from "../types.ts"

import type { ObjectExpression } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { DefaultHost } from "../shared/config-editor.ts"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { FollowUp } from "../types.ts"
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

interface HubPlan {
  features: HubFeatures
  notes: ConfigNote[]
  bindings: FeatureBindings
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

/** A `hub.db` value that the Database Definition can repeat: a string, or `process.env.NAME`. */
export type StaticValue = { kind: "literal", value: string } | { kind: "env", name: string }

/** The `hub.db` options that the codemod moves to the Database Definition or turns into follow-ups. */
export interface HubDatabaseOptions {
  /** NuxtHub's `connection.hyperdriveId` for Postgres. */
  hyperdriveId?: StaticValue
  /** NuxtHub's `driver: 'd1-http'`, with its `connection.databaseId`. */
  d1Http?: { databaseId?: StaticValue }
  /** NuxtHub's Drizzle `casing`, which Drizzle 1.0 sets per table. */
  casing?: string
  /** NuxtHub applied migrations during the build, the `applyMigrationsDuringBuild` default. */
  migrationsDuringBuild: boolean
}

function staticValue(node: Node): StaticValue | undefined {
  const literal = literalValue(node)
  if (typeof literal === "string" && literal) return { kind: "literal", value: literal }
  const value = unwrapExpression(node)
  if (value.type !== "MemberExpression" || value.object.type !== "MemberExpression") return undefined
  const { object } = value
  if (object.computed || object.object.type !== "Identifier" || object.object.name !== "process" || keyName(object.property) !== "env") return undefined
  const name = keyName(value.property, value.computed)
  return name ? { kind: "env", name } : undefined
}

/** Reads the `hub.db` options that the codemod handles. `consumed` holds the properties that need no note. */
function readDatabaseObject(object: ObjectExpression, dialect: Dialect): { options: HubDatabaseOptions, consumed: Set<Node> } {
  const options: HubDatabaseOptions = { migrationsDuringBuild: true }
  const consumed = new Set<Node>()
  const property = (name: string) => findProperty(object, name)
  const casing = property("casing")
  if (casing && typeof literalValue(casing.value) === "string") {
    options.casing = String(literalValue(casing.value))
    consumed.add(casing)
  }
  const migrations = property("applyMigrationsDuringBuild")
  if (migrations && typeof literalValue(migrations.value) === "boolean") {
    options.migrationsDuringBuild = literalValue(migrations.value) === true
    consumed.add(migrations)
  }
  const driver = property("driver")
  const d1Http = dialect === "sqlite" && driver !== undefined && literalValue(driver.value) === "d1-http"
  if (d1Http) consumed.add(driver)
  const connectionProperty = property("connection")
  const connection = connectionProperty && staticOptionsObject(connectionProperty.value)
  if (d1Http) options.d1Http = {}
  // Only the ids move to the Definition. Other connection options keep the note.
  let moved = 0
  for (const entry of connection?.properties ?? []) {
    if (entry.type !== "ObjectProperty") continue
    const key = keyName(entry.key, entry.computed)
    const value = staticValue(entry.value)
    if (value && key === "hyperdriveId" && dialect === "postgresql") options.hyperdriveId = value
    else if (value && key === "databaseId" && options.d1Http) options.d1Http.databaseId = value
    else continue
    moved++
  }
  if (connectionProperty && connection && moved === connection.properties.length) consumed.add(connectionProperty)
  return { options, consumed }
}

/** Reads the `hub.db` options that the Database Definition and the follow-ups need. */
export function readDatabaseOptions(config: NuxtConfigFile, dialect: Dialect): HubDatabaseOptions {
  const hubProperty = findProperty(config.root, "hub")
  const hub = hubProperty && staticOptionsObject(hubProperty.value)
  const db = hub && (findProperty(hub, "db") ?? findProperty(hub, "database"))
  const object = db && unwrapExpression(db.value)
  return object?.type === "ObjectExpression" ? readDatabaseObject(object, dialect).options : { migrationsDuringBuild: true }
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
  const { consumed } = readDatabaseObject(object, dialect ?? "sqlite")
  const others = object.properties.filter(property => property !== dialectProperty && !consumed.has(property))
  if (others.length) {
    notes.push({ path: ["database"], message: `hub.db also set ${others.map(property => optionText(config, property)).join(", ")}. ViteHub reads the connection, the Cloudflare binding, and the Drizzle options from server/databases/default/index.ts. Move them there by hand. See https://vitehub.dev/docs/database/configure.` })
  }
  return dialect ?? "sqlite"
}

/** Reads `hub` into features. Options that do not map 1:1 become notes. */
export function readHub(config: NuxtConfigFile): HubPlan {
  const hubProperty = findProperty(config.root, "hub")
  const value = hubProperty ? unwrapExpression(hubProperty.value) : undefined
  if (value && value.type !== "ObjectExpression") {
    throw new CodemodError(`${config.fileName} sets hub to an expression. Make it an object literal, then run the codemod again.`)
  }
  const hub: ObjectExpression | undefined = value
  const features: HubFeatures = { kv: false, blob: false, cache: false }
  const bindings: FeatureBindings = { database: "DB" }
  const notes: ConfigNote[] = []
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
      if (literal !== true) {
        notes.push({ path: [feature], message: `hub.${feature} was ${optionText(config, property.value)}. The codemod set ${feature}: true, which uses the default driver of the host. NuxtHub and ViteHub name drivers differently, so set the driver options under vitehub.${feature} by hand. See https://vitehub.dev/docs/${feature === "cache" ? "getting-started/migrate-from-nuxthub#keep-the-cache" : feature}.` })
      }
      continue
    }
    notes.push({ path: [], message: key && droppedKeys[key] ? `${droppedKeys[key]} The codemod dropped it.` : `hub.${key ?? optionText(config, property.key)} has no ViteHub option. The codemod dropped it.` })
  }
  return { features, notes, bindings }
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
  if (features.database) options.push(["database", "true"])
  for (const feature of featureKeys) {
    if (!features[feature]) continue
    const resource = hostChoice.host === "cloudflare" ? resources[feature] : undefined
    if (resource) written[feature] = resource
    options.push([feature, resource ? `{ ${Object.entries(resource).map(([key, value]) => `${key}: ${quoteString(value, style)}`).join(", ")} }` : "true"])
  }
  const followUps: Array<{ path: string[], message: string }> = [...plan.notes]
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
    followUps: followUps.map(note => ({ file: config.fileName, line: lineOf(["vitehub", ...note.path]) ?? (hubProperty ? line(hubProperty) : undefined), message: note.message })),
  }
}
