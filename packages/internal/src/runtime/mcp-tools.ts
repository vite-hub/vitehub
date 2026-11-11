/**
 * The JSON Schema of one argument. The MCP server checks these keywords itself, so a tool lists only them, plus
 * `description` and `title` for the Agent.
 */
export type ViteHubMcpValueSchema = {
  description?: string
  title?: string
  enum?: ReadonlyArray<string | number | boolean | null>
} & (
  | { type?: never }
  | { type: "boolean" }
  | { type: "integer" | "number", minimum?: number, maximum?: number }
  | { type: "string", minLength?: number, maxLength?: number }
  | { type: "array", items?: ViteHubMcpValueSchema }
  | { type: "object", properties?: Record<string, ViteHubMcpValueSchema>, required?: string[], additionalProperties?: boolean }
)

/** A JSON Schema object for the arguments of a tool. */
export interface ViteHubMcpInputSchema {
  type: "object"
  properties: Record<string, ViteHubMcpValueSchema>
  required?: string[]
  additionalProperties?: boolean
}

/** What a tool call returns: text for the Agent, and the same data as JSON. */
export interface ViteHubMcpToolResult {
  text: string
  structured?: Record<string, unknown>
  isError?: boolean
}

/** The checked caller of a tool. */
export interface ViteHubMcpToolContext {
  /** The checked user, with every field, or null for a caller without accounts. */
  user: Record<string, unknown> | null
  /** The request event with its Standard Context, when available, for owners that resolve request identity. */
  event?: { readonly "~standard": { readonly req: Request } }
}

/**
 * One tool of the ViteHub MCP server at `/_vitehub/mcp`. An owner package registers its tools when the server starts.
 * The server lists and runs a tool only for a person whose Console access includes the tool's `section`.
 */
export interface ViteHubMcpTool {
  /** Snake case and prefixed with the owner, such as `comments_list_threads`. */
  name: string
  title?: string
  description: string
  inputSchema: ViteHubMcpInputSchema
  /** Only `readOnlyHint: true` permits a read-only Console grant; other tools require full section access. */
  annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }
  /** The Console section whose access the tool needs, such as `comments`. */
  section: string
  call(input: Record<string, unknown>, context: ViteHubMcpToolContext): Promise<ViteHubMcpToolResult>
}

const registryKey: unique symbol = Symbol.for("vitehub.mcp.tools")
// SAFETY: This module owns the process slot that separately bundled owner plugins and the MCP route share.
const scope = globalThis as typeof globalThis & { [registryKey]?: Map<string, readonly ViteHubMcpTool[]> }

/** Registers the tools of one owner, such as `comments`. A second call replaces them, as in development reloads. */
export function registerViteHubMcpTools(owner: string, tools: readonly ViteHubMcpTool[]): void {
  const registry = scope[registryKey] ??= new Map()
  registry.set(owner, tools)
}

/** Every registered tool, in owner registration order. */
export function getViteHubMcpTools(): ViteHubMcpTool[] {
  return [...scope[registryKey]?.values() ?? []].flat()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function checkValue(schema: ViteHubMcpValueSchema, value: unknown, path: string): string | undefined {
  if (schema.enum && !schema.enum.some(item => item === value)) return `${path} must be one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}`
  switch (schema.type) {
    case undefined:
      return undefined
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path} must be a boolean`
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number`
      if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`
      if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`
      return undefined
    }
    case "string": {
      if (typeof value !== "string") return `${path} must be a string`
      // JSON Schema counts code points.
      const length = [...value].length
      if (schema.minLength !== undefined && length < schema.minLength) return `${path} must have at least ${schema.minLength} characters`
      if (schema.maxLength !== undefined && length > schema.maxLength) return `${path} must have at most ${schema.maxLength} characters`
      return undefined
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`
      const items = schema.items
      if (!items) return undefined
      for (const [index, item] of value.entries()) {
        const invalid = checkValue(items, item, `${path}[${index}]`)
        if (invalid) return invalid
      }
      return undefined
    }
    case "object":
      return isPlainObject(value) ? checkObject(schema, value, path) : `${path} must be an object`
  }
}

function checkObject(schema: { properties?: Record<string, ViteHubMcpValueSchema>, required?: string[], additionalProperties?: boolean }, value: Record<string, unknown>, path: string): string | undefined {
  const properties = schema.properties ?? {}
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name)) return `${path ? `${path}.` : ""}${name} is required`
  }
  for (const [name, item] of Object.entries(value)) {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined
    const at = path ? `${path}.${name}` : name
    if (!property) {
      if (schema.additionalProperties === false) return `${at} is not an argument of this tool`
      continue
    }
    const invalid = checkValue(property, item, at)
    if (invalid) return invalid
  }
  return undefined
}

/** What is wrong with the arguments of one call, or `undefined` when they match the tool's schema. */
export function checkViteHubMcpInput(schema: ViteHubMcpInputSchema, input: Record<string, unknown>): string | undefined {
  return checkObject(schema, input, "")
}
