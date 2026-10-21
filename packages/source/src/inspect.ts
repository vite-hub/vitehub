import { argumentExpression, findProperty, objectProperties, staticString, staticValue } from "@vite-hub/internal/build/scan-module"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverCollections } from "./internal/collection-discovery.ts"
import { collectionRoutePath } from "./internal/collection-route.ts"

import type { Argument, Expression, ObjectExpression } from "@vite-hub/internal/build/scan-module"
import type { ViteHubDefinitionField, ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { DiscoveredCollection } from "./internal/collection-discovery.ts"

export interface CollectionInspectionOptions {
  projectRoot: string
  /** Server directories, relative to `projectRoot` or absolute. Defaults to `server`. */
  serverDirs?: string[]
}

/** A property read from an object literal. `method` is true for `name() {}` members and accessors. */
interface Member {
  method: boolean
  value: Expression
}

// Inspection reads source only. A value that is not a literal shows as `Dynamic`.
const dynamic = "Dynamic"

function objectLiteral(value: Expression | undefined): ObjectExpression | undefined {
  return value?.type === "ObjectExpression" ? value : undefined
}

function readMember(object: ObjectExpression | undefined, name: string): Member | undefined {
  const property = object && findProperty(object, name)
  if (property?.node.type !== "Property" || property.value === undefined) return
  return { method: property.node.method || property.node.kind !== "init", value: property.value }
}

/** An identifier path such as `schema` or `tables.articles`, as written without whitespace. */
function identifierPath(value: Expression, optional: boolean): string | undefined {
  if (value.type === "Identifier") return value.name
  if (value.type !== "MemberExpression" || value.computed || value.property.type !== "Identifier" || (value.optional && !optional)) return
  const object = identifierPath(value.object, optional)
  return object === undefined ? undefined : `${object}${value.optional ? "?." : "."}${value.property.name}`
}

function callArguments(values: Argument[]): Expression[] {
  return values.flatMap(value => argumentExpression(value) ?? [])
}

function readCall(value: Expression): { arguments: Expression[], callee: string } | undefined {
  if (value.type !== "CallExpression" || value.optional) return
  const callee = identifierPath(value.callee, false)
  return callee === undefined ? undefined : { arguments: callArguments(value.arguments), callee }
}

function describeString(member: Member): string {
  return staticString(member.value) ?? dynamic
}

function describeInteger(member: Member): string {
  const value = member.value
  return value.type === "Literal" && typeof value.value === "number" && /^\d+(?:_\d+)*$/.test(value.raw ?? "") ? String(value.value) : dynamic
}

function describeStringList(member: Member): string {
  if (member.value.type !== "ArrayExpression") return dynamic
  const values = member.value.elements.map(element => element === null || element.type === "SpreadElement" ? undefined : staticString(element))
  if (values.some(value => value === undefined)) return dynamic
  return values.length ? values.join(", ") : "None"
}

/** Shows an identifier path as written and a call as `callee(...)`. Other expressions show as `Inline`. */
function describeExpression(member: Member): string {
  if (member.method) return "Inline"
  const path = identifierPath(member.value, true)
  if (path !== undefined) return path
  const call = readCall(member.value)
  return call ? `${call.callee}(...)` : "Inline"
}

function isFunction(member: Member): boolean {
  return member.method || member.value.type === "ArrowFunctionExpression" || member.value.type === "FunctionExpression"
}

function pushSchema(fields: ViteHubDefinitionField[], label: string, member: Member | undefined): void {
  if (!member) return
  fields.push({ label, value: describeExpression(member) })
  // Only an inline `object({ ... })` schema, for example `v.object()` or `z.object()`, has statically known fields.
  const call = member.method ? undefined : readCall(member.value)
  const shape = call && /(?:^|\.)(?:object|strictObject|looseObject)$/.test(call.callee) ? objectLiteral(call.arguments[0]) : undefined
  if (!shape) return
  const names = objectProperties(shape).map(property => property.key)
  fields.push({
    label: `${label} fields`,
    value: names.every(name => name !== undefined) ? names.join(", ") || "None" : dynamic,
  })
}

function pushLimits(fields: ViteHubDefinitionField[], options: ObjectExpression): void {
  const defaultLimit = readMember(options, "defaultLimit")
  const maxLimit = readMember(options, "maxLimit")
  if (defaultLimit) fields.push({ label: "Default limit", value: describeInteger(defaultLimit) })
  if (maxLimit) fields.push({ label: "Max limit", value: describeInteger(maxLimit) })
}

function describeArraySort(member: Member): string {
  const sort = objectLiteral(member.value)
  const field = readMember(sort, "field")
  const direction = readMember(sort, "direction")
  const fieldName = field && staticString(field.value)
  const directionName = direction ? staticString(direction.value) : "asc"
  return fieldName && directionName ? `${fieldName} ${directionName}` : dynamic
}

function describeTableSort(member: Member): string {
  const orderBy = objectLiteral(member.value)
  const column = readMember(orderBy, "column")
  const direction = readMember(orderBy, "direction")
  const tieBreaker = readMember(orderBy, "tieBreaker")
  const directionName = direction && staticString(direction.value)
  if (!column || !directionName) return dynamic
  const sort = `${describeExpression(column)} ${directionName}`
  return tieBreaker ? `${sort}, then ${describeExpression(tieBreaker)}` : sort
}

function arrayFields(options: ObjectExpression): ViteHubDefinitionField[] {
  const fields: ViteHubDefinitionField[] = []
  pushSchema(fields, "Schema", readMember(options, "schema"))
  const key = readMember(options, "key")
  const sort = readMember(options, "sort")
  if (key) fields.push({ label: "Key", value: describeString(key) })
  if (sort) fields.push({ label: "Sort", value: describeArraySort(sort) })
  for (const [property, label] of [["filters", "Filters"], ["search", "Search"], ["facets", "Facets"]] as const) {
    const member = readMember(options, property)
    if (member) fields.push({ label, value: describeStringList(member) })
  }
  pushLimits(fields, options)
  return fields
}

function tableFields(options: ObjectExpression): ViteHubDefinitionField[] {
  const fields: ViteHubDefinitionField[] = []
  const table = readMember(options, "table")
  const orderBy = readMember(options, "orderBy")
  const where = readMember(options, "where")
  if (table) fields.push({ label: "Table", value: describeExpression(table) })
  if (orderBy) fields.push({ label: "Sort", value: describeTableSort(orderBy) })
  pushSchema(fields, "Query schema", readMember(options, "querySchema"))
  if (where) fields.push({ label: "Where", value: isFunction(where) ? "Callback" : dynamic })
  pushLimits(fields, options)
  return fields
}

/** Fields of a custom source object and of the options in `defineCollection(load, options)`. */
function loaderFields(options: ObjectExpression): ViteHubDefinitionField[] {
  const pagination = readMember(options, "pagination")
  const fields: ViteHubDefinitionField[] = [{
    label: "Pagination",
    value: !pagination ? "Cursor" : staticString(pagination.value) === "provider" ? "Provider" : dynamic,
  }]
  pushSchema(fields, "Cursor schema", readMember(options, "cursorSchema"))
  pushSchema(fields, "Query schema", readMember(options, "querySchema"))
  pushLimits(fields, options)
  return fields
}

function sourceFields(member: Member | undefined): ViteHubDefinitionField[] {
  if (!member || member.method) return [{ label: "Source", value: "unknown" }]
  const custom = objectLiteral(member.value)
  if (custom) return [{ label: "Source", value: "custom" }, ...loaderFields(custom)]
  const call = readCall(member.value)
  if (!call) return [{ label: "Source", value: "unknown" }]
  const fields: ViteHubDefinitionField[] = [{ label: "Source", value: call.callee }]
  const helper = call.callee.split(".").at(-1)
  const optionsValue = helper === "array" ? call.arguments[1] : helper === "table" ? call.arguments[0] : undefined
  if (optionsValue === undefined) return fields
  const options = objectLiteral(optionsValue)
  if (!options) return [...fields, { label: "Options", value: dynamic }]
  return [...fields, ...helper === "array" ? arrayFields(options) : tableFields(options)]
}

function definitionFields(collection: DiscoveredCollection): ViteHubDefinitionField[] {
  const call = collection.definition
  if (!call) return [{ label: "Source", value: "unknown" }]
  const [first, second] = callArguments(call.arguments)
  // `defineCollection({ source, ... })` keeps its options in the first argument; `defineCollection(load, options)` in the second.
  const loaderForm = second !== undefined
  const options = objectLiteral(loaderForm ? second : first)
  const fields = loaderForm
    ? [{ label: "Source", value: "loader" }, ...options ? loaderFields(options) : []]
    : sourceFields(readMember(options, "source"))
  if (!options) return [...fields, { label: "Options", value: dynamic }]
  const authorize = readMember(options, "authorize")
  fields.push({ label: "Transform", value: readMember(options, "transform") ? "Yes" : "No" })
  if (authorize) {
    fields.push({
      label: "Authorize",
      value: !authorize.method && staticValue(authorize.value) === true ? "Signed-in session" : isFunction(authorize) ? "Callback" : dynamic,
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
