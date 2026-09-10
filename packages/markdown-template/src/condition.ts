import { resolveAttributes } from "comark/render"
import type { NodeRenderData } from "comark/render"

import { markdownTemplateErrorDiagnostics } from "./error-diagnostics.ts"

type Ordered = number | string
type Comparison = (value: unknown, expected: unknown) => boolean
const ordered = (compare: (value: Ordered, expected: Ordered) => boolean): Comparison => (value, expected) =>
  (typeof value === "number" && typeof expected === "number" || typeof value === "string" && typeof expected === "string")
  && compare(value, expected)

const comparisons: Record<string, Comparison> = {
  eq: (value, expected) => value === expected,
  neq: (value, expected) => value !== expected,
  gt: ordered((value, expected) => value > expected),
  gte: ordered((value, expected) => value >= expected),
  lt: ordered((value, expected) => value < expected),
  lte: ordered((value, expected) => value <= expected),
}
const allowedProps = new Set(["condition", "value", ...Object.keys(comparisons)])

export function matchesCondition(
  attributes: Record<string, unknown>,
  renderData: NodeRenderData,
  validatePath?: (path: string) => boolean,
): boolean {
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "$") continue
    if (!allowedProps.has(key.replace(/^:/, ""))) {
      throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_R0024({ message: `[vitehub] Unsupported Markdown template condition prop "${key}". Use Comark-bound condition or value props.` })
    }
    if (validatePath && key.startsWith(":") && typeof value === "string") {
      // Comark owns literal parsing and binding resolution; the consumer owns allowed data paths.
      let literal = false
      try { JSON.parse(value); literal = true }
      catch { /* A non-JSON binding is a Comark data path. */ }
      if (!literal && (!value.startsWith("data.") || !validatePath(value.slice(5)))) {
        throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_R0002({ message: `[vitehub] Unsafe Markdown template condition "${value}".` })
      }
    }
  }
  const props = resolveAttributes(attributes, renderData, { parseJson: true })
  const has = (key: string) => Object.hasOwn(props, key)
  const operators = Object.keys(comparisons).filter(has)
  if (!has("condition") && !has("value")) {
    throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_R0024({ message: "[vitehub] Markdown template if block requires a condition or value prop." })
  }
  if (has("condition") && !props.condition) return false
  if (operators.length) {
    return has("value") && props.value !== undefined
      && operators.every(operator => props[operator] !== undefined && comparisons[operator]!(props.value, props[operator]))
  }
  return has("condition") || Boolean(props.value)
}
