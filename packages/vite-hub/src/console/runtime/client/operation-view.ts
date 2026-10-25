import type { ConsoleOperationColumn, ConsoleOperationView } from "../definitions"

/** The value at a dot path, such as `messages.0.body`. Paths joined by `|` fall back in order: `author.name|author.id`. */
export function operationValue(item: unknown, path: string): unknown {
  if (path.includes("|")) {
    for (const alternative of path.split("|")) {
      const value = operationValue(item, alternative)
      if (value !== undefined && value !== null && value !== "") return value
    }
    return undefined
  }
  let current = item
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined
    current = Reflect.get(current, key)
  }
  return current
}

const excerptLength = 90

/** The text of one cell: `datetime` shows a date, `excerpt` cuts a long text. */
export function operationCell(item: unknown, column: ConsoleOperationColumn): string {
  const value = operationValue(item, column.key)
  if (value === undefined || value === null) return ""
  if (column.format === "datetime" && typeof value === "number") return new Date(value).toISOString().replace("T", " ").slice(0, 16)
  const text = typeof value === "string" ? value : String(value)
  const line = text.replaceAll(/\s+/g, " ").trim()
  return column.format === "excerpt" && line.length > excerptLength ? `${line.slice(0, excerptLength - 1)}…` : line
}

/** The link of one row, or undefined when the view has none or the row does not match `when`. */
export function operationLink(item: unknown, view: ConsoleOperationView): string | undefined {
  const link = view.link
  if (!link) return undefined
  if (link.when && operationValue(item, link.when.path) !== link.when.equals) return undefined
  let complete = true
  const href = link.template.replaceAll(/\{([^}]+)\}/g, (_match, path: string) => {
    const value = operationValue(item, path)
    if (value === undefined || value === null) complete = false
    return String(value ?? "")
  })
  return complete ? href : undefined
}

/** The items of an operation result. Anything else is a failure of the owner operation. */
export function operationItems(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) return []
  return result.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
}
