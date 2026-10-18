import { markdownTemplateErrorDiagnostics as diagnostics } from "./error-diagnostics.ts"
import { resolveAttributes } from "comark/render"
import type { NodeRenderData } from "comark/render"

// Resolve the longest explicit key before traversing nested data. A scalar key
// and its dotted descendants cannot both be represented by a nested alias tree.
function pathValue(value: unknown, parts: string[]): { value: unknown } | undefined {
  // A matched undefined value still owns the path and must prevent fallback.
  if (!parts.length) return { value }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined
  for (let length = parts.length; length > 0; length--) {
    const key = parts.slice(0, length).join(".")
    if (!Object.hasOwn(value, key)) continue
    const resolved = pathValue(Reflect.get(value, key), parts.slice(length))
    if (resolved !== undefined) return resolved
  }
  return undefined
}

export function resolveTemplateAttributes(
  attributes: Record<string, unknown>,
  renderData: NodeRenderData,
  options: { parseJson: true },
): Record<string, unknown> {
  const values: Record<string, unknown> = Object.create(null)
  const rewritten = { ...attributes }
  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith(":") || typeof value !== "string") continue
    try { JSON.parse(value); continue }
    catch { /* Let Comark retain JSON literal parsing and attribute filtering. */ }
    const alias = `binding${Object.keys(values).length}`
    values[alias] = pathValue(renderData, value.split("."))?.value
    rewritten[key] = `props.${alias}`
  }
  return resolveAttributes(rewritten, { ...renderData, props: values }, options)
}

export function resolveTemplateBinding(attributes: Record<string, unknown>, renderData: NodeRenderData, prop = "value"): unknown {
  const props = resolveTemplateAttributes(attributes, renderData, { parseJson: true })
  if (props[prop] === undefined || props[prop] === null) {
    throw diagnostics.MARKDOWN_TEMPLATE_R0017({ message: `[vitehub] Markdown template binding "${String(attributes[`:${prop}`] ?? prop)}" is not defined.` })
  }
  return props[prop]
}

export function resolveScalarTemplateBinding(attributes: Record<string, unknown>, renderData: NodeRenderData, prop = "value"): string {
  return requireScalar(resolveTemplateBinding(attributes, renderData, prop), String(attributes[`:${prop}`] ?? prop))
}

function requireScalar(value: unknown, path: string): string {
  if (value === undefined || value === null) {
    throw diagnostics.MARKDOWN_TEMPLATE_R0017({ message: `[vitehub] Markdown template binding "${path}" is not defined.` })
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  throw diagnostics.MARKDOWN_TEMPLATE_R0018({ message: `[vitehub] Markdown template binding "${path}" must resolve to a scalar value.` })
}

/** Resolves and validates bound scalar attributes before Comark serializes a tag. */
export function resolveScalarTemplateAttributes(attributes: Record<string, unknown>, renderData: NodeRenderData): Record<string, unknown> {
  const props = resolveTemplateAttributes(attributes, renderData, { parseJson: true })
  for (const key of Object.keys(attributes)) {
    if (key.startsWith(":")) requireScalar(props[key.slice(1)], String(attributes[key]))
  }
  return props
}

// Comark resolves inherited properties; expose only the explicit data for this render.
export function snapshotTemplateData<T>(value: T, seen = new WeakMap<object, object>()): T {
  // Comark resolves inherited properties; expose a stable snapshot of explicit data.
  if (!value || (typeof value !== "object" && typeof value !== "function")) return value
  // SAFETY: `value` is an object tracked in this map, so the stored clone has type T.
  // SAFETY: every value inserted into `seen` is the clone of the corresponding input object.
  if (seen.has(value)) return seen.get(value) as T
  const copy = Object.setPrototypeOf(Array.isArray(value) ? [] : {}, null)
  if (Array.isArray(value)) copy.length = value.length
  seen.set(value, copy)
  for (const key of Object.keys(value)) {
    // SAFETY: callers provide object-like data; indexing by an own enumerable key yields its value.
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    let resolved: unknown
    let loaded = false
    const read = () => {
      if (!loaded) {
        resolved = snapshotTemplateData(descriptor && "value" in descriptor ? descriptor.value : Reflect.get(value, key), seen)
        loaded = true
      }
      return resolved
    }
    Object.defineProperty(copy, key, { enumerable: true, configurable: true, get: read })
  }
  // SAFETY: `copy` mirrors the input's enumerable data shape and is returned as the same generic type.
  return copy as T
}
