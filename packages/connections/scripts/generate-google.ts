// Generate a typed Google API catalog from a Discovery document.
// Usage: node scripts/generate-google.ts gmail v1
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as v from "valibot"

interface DiscoverySchema {
  $ref?: string
  additionalProperties?: DiscoverySchema
  description?: string
  enum?: string[]
  format?: string
  items?: DiscoverySchema
  properties?: Record<string, DiscoverySchema>
  repeated?: boolean
  required?: boolean
  type?: string
}

interface DiscoveryMethod {
  description?: string
  httpMethod: string
  id: string
  parameterOrder?: string[]
  parameters?: Record<string, DiscoverySchema & { location: "path" | "query" }>
  path: string
  request?: { $ref: string }
  response?: { $ref: string }
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>
  resources?: Record<string, DiscoveryResource>
}

interface DiscoveryDocument extends DiscoveryResource {
  name: string
  revision: string
  rootUrl: string
  schemas: Record<string, DiscoverySchema & { id: string }>
  title: string
  version: string
}

const discoverySchema: v.GenericSchema<DiscoverySchema> = v.lazy(() => v.object({
  $ref: v.optional(v.string()),
  additionalProperties: v.optional(discoverySchema),
  description: v.optional(v.string()),
  enum: v.optional(v.array(v.string())),
  format: v.optional(v.string()),
  items: v.optional(discoverySchema),
  properties: v.optional(v.record(v.string(), discoverySchema)),
  repeated: v.optional(v.boolean()),
  required: v.optional(v.boolean()),
  type: v.optional(v.string()),
}))
const discoveryMethod: v.GenericSchema<DiscoveryMethod> = v.object({
  description: v.optional(v.string()),
  httpMethod: v.string(),
  id: v.string(),
  parameterOrder: v.optional(v.array(v.string())),
  parameters: v.optional(v.record(v.string(), v.intersect([discoverySchema, v.object({ location: v.picklist(["path", "query"]) })]))),
  path: v.string(),
  request: v.optional(v.object({ $ref: v.string() })),
  response: v.optional(v.object({ $ref: v.string() })),
})
const discoveryResource: v.GenericSchema<DiscoveryResource> = v.lazy(() => v.object({
  methods: v.optional(v.record(v.string(), discoveryMethod)),
  resources: v.optional(v.record(v.string(), discoveryResource)),
}))
const discoveryDocument: v.GenericSchema<DiscoveryDocument> = v.intersect([
  discoveryResource,
  v.object({
    name: v.string(),
    revision: v.string(),
    rootUrl: v.string(),
    schemas: v.record(v.string(), v.intersect([discoverySchema, v.object({ id: v.string() })])),
    title: v.string(),
    version: v.string(),
  }),
])

const [api = "gmail", version = "v1"] = process.argv.slice(2)
const response = await fetch(`https://${api}.googleapis.com/$discovery/rest?version=${version}`)
if (!response.ok) throw new Error(`Discovery request failed with ${response.status}.`)
const document = v.parse(discoveryDocument, await response.json())
const prefix = api[0]!.toUpperCase() + api.slice(1)

function summary(description: string | undefined, indent: string): string[] {
  const text = description?.replace(/\s+/g, " ").trim()
  if (!text) return []
  const sentence = /^(.+?\.)(?:\s|$)/.exec(text)?.[1] ?? text
  return [`${indent}/** ${sentence.replaceAll("*/", "*\\/").slice(0, 240)} */`]
}

function type(schema: DiscoverySchema, indent: string): string {
  if (schema.$ref) return `${prefix}${schema.$ref}`
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(" | ")
  switch (schema.type) {
    case "string": return "string"
    case "integer":
    case "number": return schema.format === "int64" || schema.format === "uint64" ? "string" : "number"
    case "boolean": return "boolean"
    case "any": return "unknown"
    case "array": return `Array<${type(schema.items ?? { type: "any" }, indent)}>`
    case "object":
      if (schema.properties) return objectType(schema.properties, indent)
      if (schema.additionalProperties) return `Record<string, ${type(schema.additionalProperties, indent)}>`
      return "Record<string, unknown>"
    default: return "unknown"
  }
}

function isRequiredProperty(schema: DiscoverySchema): boolean {
  // Gmail marks required body fields with "Required." when the Discovery flag is absent.
  return schema.required ?? schema.description?.startsWith("Required.") ?? false
}

function objectType(properties: Record<string, DiscoverySchema>, indent: string, required: readonly string[] = []): string {
  const inner = `${indent}  `
  // Discovery returns properties in a different order on each request. Sort them so the output is stable.
  const lines = Object.entries(properties).sort(([left], [right]) => left.localeCompare(right)).flatMap(([name, schema]) => [
    ...summary(schema.description, inner),
    `${inner}${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}${required.includes(name) || isRequiredProperty(schema) ? "" : "?"}: ${schema.repeated ? `Array<${type(schema, inner)}>` : type(schema, inner)}`,
  ])
  return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "Record<string, never>"
}

/**
 * The methods to type, as method ids or resource paths. A Connection still reaches every other endpoint of the API
 * with `fetch()`. An API without an entry gets every method.
 */
const typedResources: Record<string, readonly string[]> = {
  gmail: ["users.drafts", "users.getProfile", "users.history", "users.labels", "users.messages", "users.settings.filters", "users.threads"],
}

const localId = (method: DiscoveryMethod) => method.id.slice(api.length + 1)
const discovered: DiscoveryMethod[] = []
function collect(resource: DiscoveryResource): void {
  for (const method of Object.values(resource.methods ?? {})) discovered.push(method)
  for (const child of Object.values(resource.resources ?? {})) collect(child)
}
collect(document)
const typed = typedResources[api]
const methods = typed
  ? discovered.filter(method => typed.some(entry => localId(method) === entry || localId(method).startsWith(`${entry}.`)))
  : discovered
methods.sort((left, right) => left.id.localeCompare(right.id))

/** The schemas that the typed methods reach. The output leaves out the others. */
const schemas = new Set<string>()
function reach(schema: DiscoverySchema | undefined): void {
  if (!schema) return
  if (schema.$ref) {
    if (schemas.has(schema.$ref)) return
    schemas.add(schema.$ref)
    reach(document.schemas[schema.$ref])
  }
  reach(schema.items)
  reach(schema.additionalProperties)
  for (const property of Object.values(schema.properties ?? {})) reach(property)
}
for (const method of methods) {
  reach(method.request)
  reach(method.response)
  for (const parameter of Object.values(method.parameters ?? {})) reach(parameter)
}
const output = [
  `// Generated by scripts/generate-google.ts from the ${document.title} Discovery document, revision ${document.revision}. Do not edit.`,
  "",
  ...Object.values(document.schemas).filter(schema => schemas.has(schema.id)).sort((left, right) => left.id.localeCompare(right.id)).flatMap(schema => [
    ...summary(schema.description, ""),
    Object.keys(schema.properties ?? {}).length
      ? `export interface ${prefix}${schema.id} ${objectType(schema.properties ?? {}, "")}`
      : `export type ${prefix}${schema.id} = Record<string, never>`,
    "",
  ]),
  `export interface ${prefix}Methods {`,
  ...methods.flatMap((method) => {
    const required = Object.entries(method.parameters ?? {}).filter(([, parameter]) => parameter.required).map(([name]) => name)
    return [
      ...summary(method.description, "  "),
      `  ${JSON.stringify(localId(method))}: {`,
      `    method: ${JSON.stringify(method.httpMethod)}`,
      `    params: ${objectType(method.parameters ?? {}, "    ", required)}`,
      `    body: ${method.request ? `${prefix}${method.request.$ref}` : "never"}`,
      `    response: ${method.response ? `${prefix}${method.response.$ref}` : "void"}`,
      "  }",
    ]
  }),
  "}",
  "",
  `/** HTTP method, path template, and whether the method accepts a JSON request body. */`,
  `export const ${api}Methods = {`,
  ...methods.map(method => `  ${JSON.stringify(localId(method))}: [${JSON.stringify(method.httpMethod)}, ${JSON.stringify(method.path)}, ${Boolean(method.request)}],`),
  "} as const",
  "",
  `export const ${api}RootUrl = ${JSON.stringify(document.rootUrl)}`,
  "",
].join("\n")

await writeFile(fileURLToPath(new URL(`../src/google/${api}.ts`, import.meta.url)), output)
