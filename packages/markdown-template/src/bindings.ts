import { resolveAttributes } from "comark/render"
import type { NodeRenderData } from "comark/render"

// Resolve the longest explicit key before traversing nested data. A scalar key
// and its dotted descendants cannot both be represented by a nested alias tree.
function pathValue(value: unknown, parts: string[]): { value: unknown } | undefined {
  // A matched undefined value still owns the path and must prevent fallback.
  if (!parts.length) return { value }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only object-like data can own path segments.
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
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only string bindings can contain data paths.
    if (!key.startsWith(":") || typeof value !== "string") continue
    try { JSON.parse(value); continue }
    catch { /* Let Comark retain JSON literal parsing and attribute filtering. */ }
    const alias = `binding${Object.keys(values).length}`
    values[alias] = pathValue(renderData, value.split("."))?.value
    rewritten[key] = `props.${alias}`
  }
  return resolveAttributes(rewritten, { ...renderData, props: values }, options)
}
