import type { ConsoleOperationColumn, ConsoleOperationTone, ConsoleOperationView } from "../definitions"
import { resolveProjectUrl } from "./project"
import { requestConsoleOperation } from "./request"

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

/** The text of one cell: `datetime` shows a date, `excerpt` cuts a long text. Search matches this text. */
export function operationCell(item: unknown, column: ConsoleOperationColumn): string {
  const value = operationValue(item, column.key)
  if (value === undefined || value === null) return ""
  if (column.format === "datetime" && typeof value === "number") return new Date(value).toISOString().replace("T", " ").slice(0, 16)
  const text = typeof value === "string" ? value : String(value)
  const line = text.replaceAll(/\s+/g, " ").trim()
  return column.format === "excerpt" && line.length > excerptLength ? `${line.slice(0, excerptLength - 1)}…` : line
}

// The page rule of @vite-hub/comments: an app path with no second slash or backslash, whitespace, `?`, or `#`.
const pagePath = /^\/(?![/\\])[^\s\\?#]*$/
// An app URL that a server already serialized, such as `/pricing?plan=pro`: one leading slash, no whitespace or `#`.
const pageHref = /^\/(?![/\\])[^\s\\#]*$/

/**
 * The link of one row, or undefined when the view has none, the row does not match `when`, or a value is missing.
 * `{path}` fills a value with `encodeURIComponent`. `{path:path}` fills an app path: each segment is encoded, and a value
 * that is not an app path, such as `//evil.com/x`, gives no link. `{page:href}` fills an app URL that is already encoded,
 * with its query, as it is. An app path gets the app origin, so the link opens the app from an `account` Console too.
 */
export function operationLink(item: unknown, view: ConsoleOperationView): string | undefined {
  const link = view.link
  if (!link) return undefined
  if (link.when && operationValue(item, link.when.path) !== link.when.equals) return undefined
  let complete = true
  const href = link.template.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
    const asHref = name.endsWith(":href")
    const asPath = name.endsWith(":path")
    const value = operationValue(item, asPath || asHref ? name.slice(0, name.lastIndexOf(":")) : name)
    if (value === undefined || value === null) {
      complete = false
      return ""
    }
    const text = String(value)
    if (asHref) {
      if (pageHref.test(text)) return text
      complete = false
      return ""
    }
    if (!asPath) return encodeURIComponent(text)
    if (!pagePath.test(text)) {
      complete = false
      return ""
    }
    return text.split("/").map(segment => encodeURIComponent(segment)).join("/")
  })
  return complete ? resolveProjectUrl(href) : undefined
}

/** The ISO time of a `datetime` cell, or undefined when the value is not a time. */
export function operationTime(item: unknown, column: ConsoleOperationColumn): string | undefined {
  const value = operationValue(item, column.key)
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined
}

/** The label and tone of a `status` cell, such as `Open` in `info`. */
export function operationStatus(item: unknown, column: ConsoleOperationColumn): { label: string, tone: ConsoleOperationTone } | undefined {
  const text = operationCell(item, column)
  if (!text) return undefined
  const tone = column.tones && Object.hasOwn(column.tones, text) ? column.tones[text]! : "neutral"
  return { label: `${text.charAt(0).toUpperCase()}${text.slice(1)}`, tone }
}

/**
 * The call of a `switch` column for one item: its operation, and an input with each `input` key read from the item and
 * the column key set to `checked`. Undefined when the column is not a switch or the item lacks a value.
 */
export function operationSwitchCall(item: unknown, column: ConsoleOperationColumn, checked: boolean): { operation: string, input: Record<string, unknown> } | undefined {
  if (column.format !== "switch" || !column.switch) return undefined
  const input: Record<string, unknown> = {}
  for (const [key, path] of Object.entries(column.switch.input)) {
    const value = operationValue(item, path)
    if (value === undefined || value === null) return undefined
    input[key] = value
  }
  input[column.key] = checked
  return { input, operation: column.switch.operation }
}

/** The items of an operation result. Anything else is a failure of the owner operation. */
export function operationItems(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) return []
  return result.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
}

/** Load a complete list, following the operation's optional `before` cursor contract. */
export async function loadOperationItems(view: ConsoleOperationView, input: Record<string, unknown>, signal: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = []
  const pagination = view.pagination
  let next: Record<string, unknown> = { ...input, ...(pagination ? { limit: pagination.limit } : {}) }
  while (true) {
    signal.throwIfAborted()
    const page = operationItems(await requestConsoleOperation(view.operation, next, { signal }))
    items.push(...page)
    if (!pagination || page.length < pagination.limit) return items
    const last = page.at(-1)!
    const before = Object.fromEntries(Object.entries(pagination.cursor).map(([key, path]) => [key, operationValue(last, path)]))
    if (Object.values(before).some(value => value === undefined)) throw new Error("The operation returned an item without a pagination cursor.")
    next = { ...input, limit: pagination.limit, before }
  }
}
