import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { createSourceScanner } from "@vite-hub/internal/source-scanner"

import { discoverCollections } from "./internal/collection-discovery.ts"
import { collectionRoutePath } from "./internal/collection-route.ts"

import type { ViteHubDefinitionField, ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { DiscoveredCollection } from "./internal/collection-discovery.ts"

export interface CollectionInspectionOptions {
  projectRoot: string
  /** Server directories, relative to `projectRoot` or absolute. Defaults to `server`. */
  serverDirs?: string[]
}

type SourceScanner = ReturnType<typeof createSourceScanner>

/** A property read from an object literal. `method` is true for `name() {}` members, which have no value text. */
interface Member {
  method: boolean
  text: string
}

// Inspection reads source text only. A value that is not a literal shows as `Dynamic`.
const dynamic = "Dynamic"
const identifierPathPattern = /^[$_\p{ID_Start}][$\p{ID_Continue}]*(?:\s*\??\.\s*[$_\p{ID_Start}][$\p{ID_Continue}]*)*$/u
const calleePattern = /^([$_\p{ID_Start}][$\p{ID_Continue}]*(?:\s*\.\s*[$_\p{ID_Start}][$\p{ID_Continue}]*)*)\s*(?:<[^()]*>\s*)?\(/u
const functionPattern = /^(?:async\s+)?function\b|^(?:async\s*)?(?:\([\s\S]*?\)|[$_\p{ID_Start}][$\p{ID_Continue}]*)\s*(?::[^=]*?)?=>/u

function objectLiteral(text: string | undefined): string | undefined {
  return text?.startsWith("{") && text.endsWith("}") ? text : undefined
}

function readMember(scanner: SourceScanner, object: string | undefined, name: string): Member | undefined {
  if (!object) return
  const value = scanner.readObjectProperty(object, name)
  if (value !== undefined) return { method: false, text: value.replace(/\s+as\s+const$/, "") }
  if (!scanner.readObjectPropertyNames(object).includes(name)) return
  // A member without `:` is either shorthand (`{ schema }`) or a method (`authorize() {}`).
  const shorthand = scanner.splitTopLevel(object.slice(1, -1)).some(entry => scanner.stripBoundaryComments(entry) === name)
  return shorthand ? { method: false, text: name } : { method: true, text: "" }
}

function readCall(scanner: SourceScanner, text: string): { arguments: string[], callee: string } | undefined {
  const match = calleePattern.exec(text)
  if (!match) return
  const open = match[0].length - 1
  if (scanner.findMatching(text, open, "(", ")") !== text.length - 1) return
  return {
    arguments: scanner.splitTopLevel(text.slice(open + 1, -1)).map(entry => scanner.stripBoundaryComments(entry)).filter(Boolean),
    callee: match[1]!.replace(/\s+/g, ""),
  }
}

function readString(text: string): string | undefined {
  const match = /^(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`)$/.exec(text)
  return match ? match[1] ?? match[2] ?? match[3] : undefined
}

function describeString(member: Member): string {
  return readString(member.text) ?? dynamic
}

function describeInteger(member: Member): string {
  return /^\d+(?:_\d+)*$/.test(member.text) ? member.text.replaceAll("_", "") : dynamic
}

function describeStringList(scanner: SourceScanner, member: Member): string {
  if (!member.text.startsWith("[") || !member.text.endsWith("]")) return dynamic
  const values = scanner.splitTopLevel(member.text.slice(1, -1))
    .map(entry => scanner.stripBoundaryComments(entry))
    .filter(Boolean)
    .map(readString)
  if (values.some(value => value === undefined)) return dynamic
  return values.length ? values.join(", ") : "None"
}

/** Shows an identifier path as written and a call as `callee(...)`. Other expressions show as `Inline`. */
function describeExpression(scanner: SourceScanner, member: Member): string {
  if (member.method) return "Inline"
  if (identifierPathPattern.test(member.text)) return member.text.replace(/\s+/g, "")
  const call = readCall(scanner, member.text)
  return call ? `${call.callee}(...)` : "Inline"
}

function isFunction(member: Member): boolean {
  return member.method || functionPattern.test(member.text)
}

function pushSchema(scanner: SourceScanner, fields: ViteHubDefinitionField[], label: string, member: Member | undefined): void {
  if (!member) return
  fields.push({ label, value: describeExpression(scanner, member) })
  // Only an inline `object({ ... })` schema, for example `v.object()` or `z.object()`, has statically known fields.
  const call = member.method ? undefined : readCall(scanner, member.text)
  const shape = call && /(?:^|\.)(?:object|strictObject|looseObject)$/.test(call.callee) ? objectLiteral(call.arguments[0]) : undefined
  if (!shape) return
  const names = scanner.readObjectPropertyNames(shape)
  fields.push({
    label: `${label} fields`,
    value: names.every(name => name !== undefined) ? names.join(", ") || "None" : dynamic,
  })
}

function pushLimits(scanner: SourceScanner, fields: ViteHubDefinitionField[], options: string): void {
  const defaultLimit = readMember(scanner, options, "defaultLimit")
  const maxLimit = readMember(scanner, options, "maxLimit")
  if (defaultLimit) fields.push({ label: "Default limit", value: describeInteger(defaultLimit) })
  if (maxLimit) fields.push({ label: "Max limit", value: describeInteger(maxLimit) })
}

function describeArraySort(scanner: SourceScanner, member: Member): string {
  const sort = objectLiteral(member.text)
  const field = readMember(scanner, sort, "field")
  const direction = readMember(scanner, sort, "direction")
  const fieldName = field && readString(field.text)
  const directionName = direction ? readString(direction.text) : "asc"
  return fieldName && directionName ? `${fieldName} ${directionName}` : dynamic
}

function describeTableSort(scanner: SourceScanner, member: Member): string {
  const orderBy = objectLiteral(member.text)
  const column = readMember(scanner, orderBy, "column")
  const direction = readMember(scanner, orderBy, "direction")
  const tieBreaker = readMember(scanner, orderBy, "tieBreaker")
  const directionName = direction && readString(direction.text)
  if (!column || !directionName) return dynamic
  const sort = `${describeExpression(scanner, column)} ${directionName}`
  return tieBreaker ? `${sort}, then ${describeExpression(scanner, tieBreaker)}` : sort
}

function arrayFields(scanner: SourceScanner, options: string): ViteHubDefinitionField[] {
  const fields: ViteHubDefinitionField[] = []
  pushSchema(scanner, fields, "Schema", readMember(scanner, options, "schema"))
  const key = readMember(scanner, options, "key")
  const sort = readMember(scanner, options, "sort")
  if (key) fields.push({ label: "Key", value: describeString(key) })
  if (sort) fields.push({ label: "Sort", value: describeArraySort(scanner, sort) })
  for (const [property, label] of [["filters", "Filters"], ["search", "Search"], ["facets", "Facets"]] as const) {
    const member = readMember(scanner, options, property)
    if (member) fields.push({ label, value: describeStringList(scanner, member) })
  }
  pushLimits(scanner, fields, options)
  return fields
}

function tableFields(scanner: SourceScanner, options: string): ViteHubDefinitionField[] {
  const fields: ViteHubDefinitionField[] = []
  const table = readMember(scanner, options, "table")
  const orderBy = readMember(scanner, options, "orderBy")
  const where = readMember(scanner, options, "where")
  if (table) fields.push({ label: "Table", value: describeExpression(scanner, table) })
  if (orderBy) fields.push({ label: "Sort", value: describeTableSort(scanner, orderBy) })
  pushSchema(scanner, fields, "Query schema", readMember(scanner, options, "querySchema"))
  if (where) fields.push({ label: "Where", value: isFunction(where) ? "Callback" : dynamic })
  pushLimits(scanner, fields, options)
  return fields
}

/** Fields of a custom source object and of the options in `defineCollection(load, options)`. */
function loaderFields(scanner: SourceScanner, options: string): ViteHubDefinitionField[] {
  const pagination = readMember(scanner, options, "pagination")
  const fields: ViteHubDefinitionField[] = [{
    label: "Pagination",
    value: !pagination ? "Cursor" : readString(pagination.text) === "provider" ? "Provider" : dynamic,
  }]
  pushSchema(scanner, fields, "Cursor schema", readMember(scanner, options, "cursorSchema"))
  pushSchema(scanner, fields, "Query schema", readMember(scanner, options, "querySchema"))
  pushLimits(scanner, fields, options)
  return fields
}

function sourceFields(scanner: SourceScanner, member: Member | undefined): ViteHubDefinitionField[] {
  if (!member || member.method) return [{ label: "Source", value: "unknown" }]
  const custom = objectLiteral(member.text)
  if (custom) return [{ label: "Source", value: "custom" }, ...loaderFields(scanner, custom)]
  const call = readCall(scanner, member.text)
  if (!call) return [{ label: "Source", value: "unknown" }]
  const fields: ViteHubDefinitionField[] = [{ label: "Source", value: call.callee }]
  const helper = call.callee.split(".").at(-1)
  const optionsText = helper === "array" ? call.arguments[1] : helper === "table" ? call.arguments[0] : undefined
  if (optionsText === undefined) return fields
  const options = objectLiteral(optionsText)
  if (!options) return [...fields, { label: "Options", value: dynamic }]
  return [...fields, ...helper === "array" ? arrayFields(scanner, options) : tableFields(scanner, options)]
}

function definitionFields(collection: DiscoveredCollection): ViteHubDefinitionField[] {
  const call = collection.definition
  if (!call) return [{ label: "Source", value: "unknown" }]
  const scanner = createSourceScanner(collection.file)
  const [first, second] = call.arguments.map(argument => scanner.stripBoundaryComments(argument)).filter(Boolean)
  // `defineCollection({ source, ... })` keeps its options in the first argument; `defineCollection(load, options)` in the second.
  const loaderForm = second !== undefined
  const options = objectLiteral(loaderForm ? second : first)
  const fields = loaderForm
    ? [{ label: "Source", value: "loader" }, ...options ? loaderFields(scanner, options) : []]
    : sourceFields(scanner, readMember(scanner, options, "source"))
  if (!options) return [...fields, { label: "Options", value: dynamic }]
  const authorize = readMember(scanner, options, "authorize")
  fields.push({ label: "Transform", value: readMember(scanner, options, "transform") ? "Yes" : "No" })
  if (authorize) {
    fields.push({
      label: "Authorize",
      value: authorize.text === "true" ? "Signed-in session" : isFunction(authorize) ? "Callback" : dynamic,
    })
  }
  return fields
}

function summarizeCollection(projectRoot: string, collection: DiscoveredCollection): ViteHubDefinitionSummary {
  return {
    fields: [
      ...definitionFields(collection),
      { label: "Route", value: collection.route ? `GET ${collectionRoutePath(collection.name)}` : "Disabled" },
    ],
    file: relativeDefinitionFile(projectRoot, collection.file),
    name: collection.name,
    source: "server-collections",
  }
}

/**
 * Lists Collections in `server/collections` with their source kind and static options. It reads the module text and
 * does not import it, so values that are computed at runtime show as `Dynamic`.
 */
export async function inspectCollectionDefinitions(options: CollectionInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  return (await discoverCollections(options)).map(collection => summarizeCollection(options.projectRoot, collection))
}
