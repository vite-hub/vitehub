/** A statement in a pending migration that removes data. */
export interface DataLossStatement {
  reason: string
  statement: string
}

/** Columns of each table before a migration, from the previous Drizzle snapshot. `undefined` when the snapshot is missing. */
export type TableColumns = ReadonlyMap<string, readonly string[]>

const identifier = String.raw`(?:"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[\w$]+)`
const qualifiedName = String.raw`(?:${identifier}\s*\.\s*)?${identifier}`

/** Splits SQL into statements at semicolons outside of quotes and comments. Comments are removed. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let quote: "'" | '"' | "`" | "]" | undefined
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (quote) {
      current += char
      if (char === quote) {
        // SQL escapes quote characters by doubling them. A closing bracket in
        // a SQLite identifier uses the same convention.
        if (next === quote) {
          current += next
          index++
        }
        else {
          quote = undefined
        }
      }
      continue
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index)
      index = end === -1 ? sql.length : end - 1
      continue
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2)
      index = end === -1 ? sql.length : end + 1
      current += " "
      continue
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char
      current += char
      continue
    }
    if (char === "[") {
      quote = "]"
      current += char
      continue
    }
    if (char === ";") {
      if (current.trim()) statements.push(`${current.trim()};`)
      current = ""
      continue
    }
    current += char
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

/** Removes the quotes and the schema of a table or column name. */
function unquote(name: string): string {
  const last = name.match(new RegExp(`${identifier}$`))?.[0] ?? name
  if (/^["`]/.test(last)) return last.slice(1, -1).replaceAll(last[0]! + last[0]!, last[0]!)
  if (last.startsWith("[")) return last.slice(1, -1)
  return last
}

function listNames(list: string): string[] {
  return [...list.matchAll(new RegExp(identifier, "g"))].map(match => unquote(match[0]))
}

const dropTable = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${qualifiedName}(?:\s*,\s*${qualifiedName})*)`, "i")
// Postgres allows `ALTER TABLE t DROP c` without COLUMN. Other DROP forms of ALTER TABLE keep the rows.
const alterDrop = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${qualifiedName})\s+DROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|EXPRESSION\b|IDENTITY\b)(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${identifier})`, "i")
const truncate = new RegExp(String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(${qualifiedName})`, "i")
const deleteFrom = new RegExp(String.raw`^DELETE\s+FROM\s+(${qualifiedName})`, "i")
const dropSchema = new RegExp(String.raw`^DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?(${identifier})`, "i")
const renameTable = new RegExp(String.raw`^ALTER\s+TABLE\s+(${qualifiedName})\s+RENAME\s+TO\s+(${qualifiedName})`, "i")
const copyRows = new RegExp(String.raw`^INSERT\s+INTO\s+(${qualifiedName})\s*\(([^)]*)\)\s*SELECT\b[\s\S]*?\bFROM\s+(${qualifiedName})`, "i")

interface Rebuild {
  /** Columns that the copy keeps, or `undefined` when no copy was found. */
  copied?: string[]
}

/** Finds SQLite table rebuilds: copy rows into a new table, drop the old table, and rename the new table to the old name. */
function findRebuilds(statements: readonly string[]): Map<string, Rebuild> {
  const renamedTo = new Map<string, string>()
  for (const statement of statements) {
    const match = statement.match(renameTable)
    if (match) renamedTo.set(unquote(match[1]!).toLowerCase(), unquote(match[2]!).toLowerCase())
  }
  const rebuilds = new Map<string, Rebuild>()
  for (const target of renamedTo.values()) rebuilds.set(target, {})
  for (const statement of statements) {
    const match = statement.match(copyRows)
    if (!match) continue
    const into = unquote(match[1]!).toLowerCase()
    const from = unquote(match[3]!).toLowerCase()
    if (renamedTo.get(into) === from) rebuilds.set(from, { copied: listNames(match[2]!) })
  }
  return rebuilds
}

function describeRebuild(table: string, rebuild: Rebuild, before: TableColumns | undefined): string | undefined {
  const columns = before?.get(table.toLowerCase())
  if (!rebuild.copied || !columns) return `rebuilds table "${table}", and ViteHub cannot confirm that the copy keeps every column`
  const copied = new Set(rebuild.copied.map(column => column.toLowerCase()))
  const lost = columns.filter(column => !copied.has(column.toLowerCase()))
  if (!lost.length) return
  return `rebuilds table "${table}" without ${lost.length === 1 ? "column" : "columns"} ${lost.map(column => `"${column}"`).join(", ")}`
}

/**
 * Lists the statements of one migration that remove rows, columns, or tables.
 * `before` holds the columns of each table before the migration, so a SQLite table rebuild that keeps every column is safe.
 */
export function findDataLoss(statements: readonly string[], before?: TableColumns): DataLossStatement[] {
  const split = statements.flatMap(splitSqlStatements)
  const rebuilds = findRebuilds(split)
  const found: DataLossStatement[] = []
  for (const statement of split) {
    const reason = classifyStatement(statement, rebuilds, before)
    if (reason) found.push({ reason, statement })
  }
  return found
}

function classifyStatement(statement: string, rebuilds: ReadonlyMap<string, Rebuild>, before: TableColumns | undefined): string | undefined {
  let match = statement.match(dropTable)
  if (match) {
    const reasons = listQualifiedNames(match[1]!).map((table) => {
      const rebuild = rebuilds.get(table.toLowerCase())
      return rebuild ? describeRebuild(table, rebuild, before) : `drops table "${table}"`
    }).filter(Boolean)
    return reasons.length ? reasons.join("; ") : undefined
  }
  if ((match = statement.match(alterDrop))) return `drops column "${unquote(match[2]!)}" from "${unquote(match[1]!)}"`
  if ((match = statement.match(truncate))) return `deletes every row of "${unquote(match[1]!)}"`
  if ((match = statement.match(deleteFrom)) && !hasKeywordOutsideQuotes(statement, "WHERE")) return `deletes every row of "${unquote(match[1]!)}"`
  if ((match = statement.match(dropSchema))) return `drops schema "${unquote(match[1]!)}"`
  return undefined
}

/** Finds a SQL keyword while ignoring quoted identifiers and string literals. */
function hasKeywordOutsideQuotes(sql: string, keyword: string): boolean {
  let quote: "'" | '"' | "`" | "]" | undefined
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (quote) {
      if (char === quote) {
        if (next === quote) index++
        else quote = undefined
      }
      continue
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char
      continue
    }
    if (char === "[") {
      quote = "]"
      continue
    }
    if (sql.slice(index, index + keyword.length).toUpperCase() === keyword
      && (index === 0 || !/[\w$]/.test(sql[index - 1]!))
      && (index + keyword.length === sql.length || !/[\w$]/.test(sql[index + keyword.length]!))) return true
  }
  return false
}

function listQualifiedNames(list: string): string[] {
  return [...list.matchAll(new RegExp(qualifiedName, "g"))].map(match => unquote(match[0]))
}
