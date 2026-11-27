import type { DatabaseDialect } from "../types.ts"

/** A statement in a pending migration that removes data. */
export interface DataLossStatement {
  reason: string
  statement: string
  /** The tables that lose data. Empty or missing when the loss is wider than tables, like `DROP SCHEMA`. */
  tables?: string[]
}

/** Columns of each table before a migration, from the previous Drizzle snapshot. `undefined` when the snapshot is missing. */
export type TableColumns = ReadonlyMap<string, readonly string[]>

/** A foreign key whose ON DELETE action changes rows of `table` when the table it references is dropped. */
export interface ReferencingKey {
  table: string
  columns: readonly string[]
  /** `CASCADE`, `SET NULL`, or `SET DEFAULT`. */
  onDelete: string
}

/** The foreign keys that reference each table before a migration, by referenced table in lower case. */
export type TableReferences = ReadonlyMap<string, readonly ReferencingKey[]>

const identifier = String.raw`(?:"(?:[^"]|"")+"|'(?:[^']|'')+'|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[\w$]+)`
const qualifiedName = String.raw`(?:${identifier}\s*\.\s*)?${identifier}`
const schemaQualifiedTable = new RegExp(String.raw`^${identifier}\.${identifier}$`)

/** Splits SQL into statements at semicolons outside of quotes, Postgres dollar quotes, and comments. Comments are removed. */
export function splitSqlStatements(sql: string, dialect: DatabaseDialect = "sqlite"): string[] {
  return scanSqlStatements(sql, dialect).statements
}

const statementBreakpoint = "--> statement-breakpoint"

/**
 * Adds Drizzle's `--> statement-breakpoint` between the statements of each part of a migration, such as a hand-written
 * file that Wrangler runs as one script, or a custom migration. Drizzle runs each part with one libSQL `execute()`,
 * which runs only the first statement and drops the rest without an error. A part with one statement stays as it is,
 * so a file that Drizzle Kit wrote keeps its bytes and its hash. The statements of a SQLite trigger body stay together.
 */
export function addStatementBreakpoints(sql: string, dialect: DatabaseDialect = "sqlite"): string {
  if (dialect === "postgresql") return addPartBreakpoints(sql, dialect)
  return breakpointParts(sql, dialect).map(part => addPartBreakpoints(part, dialect)).join(statementBreakpoint)
}

function breakpointParts(sql: string, dialect: DatabaseDialect): string[] {
  if (dialect === "sqlite") return sql.split(statementBreakpoint)
  const parts: string[] = []
  let start = 0
  for (const breakpoint of scanSqlStatements(sql, dialect).breakpoints) {
    parts.push(sql.slice(start, breakpoint))
    start = breakpoint + statementBreakpoint.length
  }
  return [...parts, sql.slice(start)]
}

const noTransactionMarker = "-- vitehub:no-transaction"

/** True when the first line that is not blank is `-- vitehub:no-transaction`. Postgres runs such a file outside a transaction. */
export function isNoTransactionMigration(sql: string): boolean {
  return sql.trimStart().split("\n", 1)[0]!.trim() === noTransactionMarker
}

/**
 * The parts of a migration that Drizzle runs one by one. A SQLite part has one statement, as `addStatementBreakpoints()`
 * cuts it. Postgres runs a part of several statements in one query, so its parts stay as written.
 */
export function migrationParts(sql: string, dialect: DatabaseDialect): string[] {
  return breakpointParts(dialect === "sqlite" ? addStatementBreakpoints(sql) : sql, dialect)
    .map(part => part.trim())
    .filter(part => splitSqlStatements(part, dialect).length)
}

function addPartBreakpoints(sql: string, dialect: DatabaseDialect): string {
  const { ends, statements } = scanSqlStatements(sql, dialect)
  if (statements.length < 2) return sql
  const cuts: number[] = []
  let trigger = false
  for (const [index, statement] of statements.entries()) {
    if (dialect === "sqlite" && /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(statement)) trigger = true
    if (trigger && !/^END\s*;$/i.test(statement)) continue
    trigger = false
    const end = ends[index]
    if (end !== undefined && index < statements.length - 1) cuts.push(end)
  }
  let result = ""
  let start = 0
  for (const cut of cuts) {
    result += `${sql.slice(start, cut)}\n${statementBreakpoint}\n`
    start = cut
  }
  return result + sql.slice(start)
}

/** The statements of `splitSqlStatements()`, and the index after the semicolon that ends each one. */
function scanSqlStatements(sql: string, dialect: DatabaseDialect): { ends: (number | undefined)[], statements: string[], breakpoints: number[] } {
  const ends: (number | undefined)[] = []
  const statements: string[] = []
  const breakpoints: number[] = []
  const postgres = dialect === "postgresql"
  const word = /[A-Z_a-z\u0080-\uFFFF][\w$\u0080-\uFFFF]*/y
  const tag = /\$(?:[A-Z_a-z\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$/y
  const lineEnd = /[\r\n]/g
  let current = ""
  let quote: "'" | '"' | "`" | "]" | undefined
  let escapeString = false
  let standardStrings = true
  let parens = 0
  let atomicDepth = 0
  let pendingBegin = false
  const finish = (end?: number) => {
    const statement = current.trim()
    if (!statement) return
    if (postgres) {
      const setting = /^SET\s+(?:(?:LOCAL|SESSION)\s+)?standard_conforming_strings\s*(?:=|\bTO\b)\s*'?([\w]+)'?$/i.exec(statement)?.[1]
      if (setting) standardStrings = !/^(?:off|false|no|0)$/i.test(setting)
      else if (/^RESET\s+(?:standard_conforming_strings|ALL)$/i.test(statement)) standardStrings = true
    }
    statements.push(end === undefined ? statement : `${statement};`)
    ends.push(end)
  }
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (quote) {
      current += char
      if (escapeString && char === "\\" && next !== undefined) {
        current += next
        index++
      }
      else if (char === quote) {
        if (next === quote) {
          current += next
          index++
        }
        else {
          quote = undefined
          escapeString = false
        }
      }
      continue
    }
    if (char === "-" && next === "-") {
      lineEnd.lastIndex = index
      const end = postgres ? (lineEnd.exec(sql)?.index ?? -1) : sql.indexOf("\n", index)
      if (postgres && !atomicDepth && !parens && sql.slice(index, end === -1 ? sql.length : end).trimEnd() === statementBreakpoint) {
        breakpoints.push(index)
        finish()
        if (ends.length) ends[ends.length - 1] = undefined
        current = ""
      }
      index = end === -1 ? sql.length : end - 1
      continue
    }
    if (char === "/" && next === "*") {
      if (postgres) {
        index = postgresBlockCommentEnd(sql, index)
      }
      else {
        const end = sql.indexOf("*/", index + 2)
        index = end === -1 ? sql.length : end + 1
      }
      current += " "
      continue
    }
    word.lastIndex = index
    const token = postgres ? word.exec(sql)?.[0] : undefined
    if (token) {
      const keyword = token.toUpperCase()
      if (keyword === "ATOMIC" && pendingBegin) atomicDepth++
      if (atomicDepth && keyword === "CASE") atomicDepth++
      if (atomicDepth && keyword === "END") atomicDepth--
      pendingBegin = keyword === "BEGIN" && /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(current)
      current += token
      index += token.length - 1
      if (keyword === "E" && sql[index + 1] === "'") {
        quote = "'"
        escapeString = true
        current += "'"
        index++
      }
      continue
    }
    if (!/\s/.test(char)) pendingBegin = false
    tag.lastIndex = index
    const dollarQuote = postgres && char === "$" && !/[\w$\u0080-\uFFFF]/.test(sql[index - 1] ?? "") ? tag.exec(sql)?.[0] : undefined
    if (dollarQuote) {
      const end = sql.indexOf(dollarQuote, index + dollarQuote.length)
      const stop = end === -1 ? sql.length : end + dollarQuote.length
      current += sql.slice(index, stop)
      index = stop - 1
      continue
    }
    if (char === "'" || char === "\"" || (!postgres && char === "`")) {
      quote = char
      escapeString = postgres && char === "'" && !standardStrings
      current += char
      continue
    }
    if (!postgres && char === "[") {
      quote = "]"
      current += char
      continue
    }
    if (postgres && char === "(") parens++
    if (postgres && char === ")") parens--
    if (char === ";" && !parens && !atomicDepth) {
      finish(index + 1)
      current = ""
      continue
    }
    current += char
  }
  finish()
  return { breakpoints, ends, statements }
}

function postgresBlockCommentEnd(sql: string, start: number): number {
  const delimiters = /\/\*|\*\//g
  delimiters.lastIndex = start + 2
  let depth = 1
  for (let match = delimiters.exec(sql); match; match = delimiters.exec(sql)) {
    depth += match[0] === "/*" ? 1 : -1
    if (!depth) return match.index + 1
  }
  return sql.length - 1
}

/** Names a table the same way in every statement: unquoted parts in lower case, quoted parts as written. */
function tableKey(name: string): string {
  return [...name.matchAll(new RegExp(identifier, "g"))].map(([part]) => {
    const value = /^["'`[]/.test(part) ? unquote(part) : part.toLowerCase()
    // Keep separators inside quoted names distinct from schema separators.
    return /^[\w$]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`
  }).join(".")
}

/** Removes the quotes and the schema of a table or column name. */
function unquote(name: string): string {
  const last = name.match(new RegExp(`${identifier}$`))?.[0] ?? name
  if (/^["'`]/.test(last)) return last.slice(1, -1).replaceAll(last[0]! + last[0]!, last[0]!)
  if (last.startsWith("[")) return last.slice(1, -1)
  return last
}

function listNames(list: string): string[] {
  return [...list.matchAll(new RegExp(identifier, "g"))].map(match => unquote(match[0]))
}

const dropTable = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${qualifiedName}(?:\s*,\s*${qualifiedName})*)`, "i")
// Postgres allows `ALTER TABLE t DROP c` without COLUMN. Other DROP forms of ALTER TABLE keep the rows.
const alterDrop = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${qualifiedName})\s+DROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|EXPRESSION\b|IDENTITY\b)(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${identifier})`, "i")
const truncateTarget = String.raw`(?:ONLY\s+)?(${qualifiedName})(?:\s*\*)?`
const truncate = new RegExp(String.raw`^TRUNCATE\s+(?:TABLE\s+)?(${truncateTarget}(?:\s*,\s*${truncateTarget})*)`, "i")
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
 * A rebuild drops the old table. D1 always enforces foreign keys, and ViteHub runs SQLite and libSQL migrations in one
 * transaction, where `PRAGMA foreign_keys=OFF` does nothing, so the drop runs the ON DELETE action of each table that
 * references the rebuilt one.
 */
function describeReferencingRows(table: string, references: TableReferences | undefined, action: string): { reason: string, tables: string[] } | undefined {
  const keys: ReferencingKey[] = []
  const visited = new Set([table.toLowerCase()])
  const visit = (parent: string) => {
    for (const key of references?.get(parent) ?? []) {
      if (key.table.toLowerCase() === table.toLowerCase()) continue
      keys.push(key)
      // SET NULL and SET DEFAULT change rows without deleting them, so only CASCADE propagates ON DELETE actions.
      const child = key.table.toLowerCase()
      if (key.onDelete === "CASCADE" && !visited.has(child)) {
        visited.add(child)
        visit(child)
      }
    }
  }
  visit(table.toLowerCase())
  if (!keys.length) return
  const actions = keys.map(key => `${key.onDelete === "CASCADE" ? "deletes the rows of" : "clears"} "${key.table}"."${key.columns.join(`", "`)}" (ON DELETE ${key.onDelete})`)
  return { reason: `${action} ${actions.join(", ")}`, tables: [...new Set(keys.map(key => tableKey(key.table)))] }
}

/**
 * Lists the statements of one migration that remove rows, columns, or tables.
 * `before` holds the columns of each table before the migration, so a SQLite table rebuild that keeps every column is safe.
 */
export function findDataLoss(statements: readonly string[], before?: TableColumns, references?: TableReferences, dialect: DatabaseDialect = "sqlite"): DataLossStatement[] {
  const split = statements.flatMap(statement => splitSqlStatements(statement, dialect))
  const rebuilds = findRebuilds(split)
  const found: DataLossStatement[] = []
  for (const statement of split) {
    const loss = classifyStatement(statement, rebuilds, before, references)
    if (loss) found.push({ ...loss, statement })
  }
  return found
}

function classifyStatement(statement: string, rebuilds: ReadonlyMap<string, Rebuild>, before: TableColumns | undefined, references: TableReferences | undefined): Omit<DataLossStatement, "statement"> | undefined {
  let match = statement.match(dropTable)
  if (match) {
    const losses = [...match[1]!.matchAll(new RegExp(qualifiedName, "g"))].flatMap(([name]) => {
      const table = unquote(name)
      const rebuild = rebuilds.get(table.toLowerCase())
      if (!rebuild) {
        const referencing = describeReferencingRows(table, references, `drops table "${table}", which`)
        return [referencing ? { reason: referencing.reason, tables: [tableKey(name), ...referencing.tables] } : { reason: `drops table "${table}"`, tables: [tableKey(name)] }]
      }
      const reason = describeRebuild(table, rebuild, before)
      const referencing = describeReferencingRows(table, references, `rebuilds table "${table}", and dropping the old table`)
      return [
        ...(reason ? [{ reason, tables: [tableKey(name)] }] : []),
        ...(referencing ? [referencing] : []),
      ]
    })
    return losses.length ? { reason: losses.map(loss => loss.reason).join("; "), tables: losses.flatMap(loss => loss.tables) } : undefined
  }
  if ((match = statement.match(alterDrop))) return { reason: `drops column "${unquote(match[2]!)}" from "${unquote(match[1]!)}"`, tables: [tableKey(match[1]!)] }
  if ((match = statement.match(truncate))) {
    const targets = [...match[1]!.matchAll(new RegExp(truncateTarget, "gi"))]
    const names = targets.map(target => target[1]!)
    // CASCADE adds referencing tables; without ONLY PostgreSQL also truncates descendants.
    const explicitOnly = targets.every(target => /^ONLY\b/i.test(target[0]))
      && !hasKeywordOutsideQuotes(statement.slice(match[0].length), "CASCADE")
    return { reason: names.map(name => `deletes every row of "${unquote(name)}"`).join("; "), tables: explicitOnly ? names.map(tableKey) : [] }
  }
  if ((match = statement.match(deleteFrom)) && !hasKeywordOutsideQuotes(statement, "WHERE")) {
    const table = unquote(match[1]!)
    const referencing = describeReferencingRows(table, references, `deletes every row of "${table}", which`)
    return referencing ? { reason: referencing.reason, tables: [tableKey(match[1]!), ...referencing.tables] } : { reason: `deletes every row of "${table}"`, tables: [tableKey(match[1]!)] }
  }
  if ((match = statement.match(dropSchema))) return { reason: `drops schema "${unquote(match[1]!)}"`, tables: [] }
  return undefined
}

/** Finds a SQL keyword while ignoring quoted identifiers and string literals. */
function hasKeywordOutsideQuotes(sql: string, keyword: string): boolean {
  return keywordIndexes(sql, keyword).length > 0
}

/** Lists where a SQL keyword starts, ignoring quoted identifiers and string literals. */
function keywordIndexes(sql: string, keyword: string): number[] {
  const found: number[] = []
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
      && (index + keyword.length === sql.length || !/[\w$]/.test(sql[index + keyword.length]!))) found.push(index)
  }
  return found
}

/** A migration with the statements it runs and the data loss that `findDataLoss()` found in them. */
export interface DataLossMigration {
  dataLoss: DataLossStatement[]
  statements: readonly string[]
}

const alterTable = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${qualifiedName})`, "i")
const referencedTable = new RegExp(String.raw`^\s*(${qualifiedName})`)
const createTable = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(${qualifiedName})`, "i")
const renameTo = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${qualifiedName})\s+RENAME\s+TO\s+(${qualifiedName})`, "i")
const setSchema = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${qualifiedName}\s+SET\s+SCHEMA\b`, "i")
const writeInto = new RegExp(String.raw`^(?:(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?(?:\s+ONLY)?)\s+(${qualifiedName})`, "i")
// Statements that cannot put rows of one table into another.
const keepsRows = /^(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+(?:INDEX|VIEW|TRIGGER|TYPE|SEQUENCE|SCHEMA)|CREATE\s+(?:TYPE|SCHEMA|SEQUENCE|EXTENSION)|DELETE|TRUNCATE|PRAGMA|COMMENT\s+ON|SELECT)\b/i
const sourceTable = new RegExp(String.raw`^\s+(?:ONLY\s+)?(${qualifiedName})(?:\s+(?:AS\s+)?${identifier})?(\s*,)?`, "i")

/**
 * Lists the tables read after `FROM`, `JOIN`, or a PostgreSQL `TABLE` query, or `undefined` when it cannot tell,
 * for example with a comma join. A `CREATE TABLE` prefix must be removed before calling this.
 */
function readTables(statement: string): string[] | undefined {
  const tables: string[] = []
  for (const keyword of ["FROM", "JOIN", "TABLE"]) {
    for (const index of keywordIndexes(statement, keyword)) {
      const match = statement.slice(index + keyword.length).match(sourceTable)
      // A subquery in parentheses names its own tables after its own FROM.
      if (!match) {
        if (/^\s*\(/.test(statement.slice(index + keyword.length))) continue
        return
      }
      if (match[2]) return
      tables.push(tableKey(match[1]!))
    }
  }
  return tables
}

interface NewTables {
  dialect: DatabaseDialect
  /** Tables that hold only rows written by this run, or that this run dropped. */
  noOlderRows: Set<string>
  /** Tables that a trigger writes into. A later write to another table can copy older rows into them. */
  fedByTrigger: Set<string>
  /** True between `CREATE TRIGGER` and its `END`, which the statement split cuts into parts. */
  inTrigger: boolean
  referencedBy: Map<string, Set<string>>
  deleteOrUpdateTriggers: Set<string>
  unknownTriggerSeen: boolean
  /** Temporary SQLite tables make unqualified names switch schemas after a drop or rename. */
  temporaryTableSeen: boolean
}

function referenceKey(name: string, { dialect }: NewTables): string {
  return dialect === "sqlite" ? unquote(name).toLowerCase() : name
}

function trackReferences(statement: string, owner: string, tables: NewTables) {
  const { referencedBy } = tables
  for (const index of keywordIndexes(statement, "REFERENCES")) {
    const match = statement.slice(index + "REFERENCES".length).match(referencedTable)
    if (!match) continue
    const parent = referenceKey(tableKey(match[1]!), tables)
    referencedBy.set(parent, (referencedBy.get(parent) ?? new Set()).add(owner))
  }
}

function renameReferences(from: string, to: string, tables: NewTables) {
  const { referencedBy } = tables
  const oldKey = referenceKey(from, tables)
  const newKey = referenceKey(to, tables)
  const children = referencedBy.get(oldKey)
  if (children) {
    referencedBy.set(newKey, new Set([...referencedBy.get(newKey) ?? [], ...children]))
    if (tables.dialect !== "sqlite") referencedBy.delete(oldKey)
  }
  for (const set of referencedBy.values()) {
    if (set.delete(from)) set.add(to)
  }
}

function holdsNoOlderRows(table: string, tables: NewTables, dropped: ReadonlySet<string> | undefined): boolean {
  const visited = new Set<string>()
  const visit = (name: string): boolean => {
    if (visited.has(name)) return true
    visited.add(name)
    const key = referenceKey(name, tables)
    if (dropped && (tables.unknownTriggerSeen || (!dropped.has(key) && tables.deleteOrUpdateTriggers.has(key)))) return false
    return tables.noOlderRows.has(name) && [...tables.referencedBy.get(key) ?? []].every(visit)
  }
  return visit(table)
}

const createTrigger = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i
const sqliteTriggerTarget = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?${qualifiedName}\s+(?:(?:BEFORE|AFTER|INSTEAD\s+OF)\s+)?(INSERT|DELETE|UPDATE)(?:\s+OF\s+${identifier}(?:\s*,\s*${identifier})*)?\s+ON\s+(${qualifiedName})(?=\s|$)`, "i")

function feedByTrigger(statement: string, tables: NewTables) {
  const match = statement.match(writeInto)
  if (!match) return
  tables.fedByTrigger.add(tableKey(match[1]!))
  tables.noOlderRows.delete(tableKey(match[1]!))
}

/** Updates the tables that hold no rows from before this run of migrations, after a statement runs. */
function trackNewTables(statement: string, tables: NewTables) {
  const { noOlderRows } = tables
  if (tables.temporaryTableSeen) return
  if (tables.inTrigger) {
    if (/^END\b/i.test(statement)) tables.inTrigger = false
    else feedByTrigger(statement, tables)
    return
  }
  if (createTrigger.test(statement)) {
    if (tables.dialect === "sqlite") {
      const trigger = statement.match(sqliteTriggerTarget)
      if (!trigger) tables.unknownTriggerSeen = true
      else if (trigger[1]!.toUpperCase() !== "INSERT") tables.deleteOrUpdateTriggers.add(referenceKey(tableKey(trigger[2]!), tables))
    }
    const begin = keywordIndexes(statement, "BEGIN")[0]
    if (begin === undefined) {
      noOlderRows.clear()
      return
    }
    feedByTrigger(statement.slice(begin + "BEGIN".length).trim(), tables)
    tables.inTrigger = true
    return
  }
  const readsOnlyNewRows = (query = statement) => readTables(query)?.every(table => noOlderRows.has(table)) ?? false
  const add = (table: string) => {
    // An unqualified PostgreSQL name can resolve to a different table after a drop or rename.
    if (tables.dialect === "postgresql" && !schemaQualifiedTable.test(table)) return
    if (!tables.fedByTrigger.has(table)) noOlderRows.add(table)
  }
  const forget = (table: string) => {
    // An unqualified target may refer to any tracked schema's table.
    if (tables.dialect === "postgresql" && !schemaQualifiedTable.test(table)) noOlderRows.clear()
    else noOlderRows.delete(table)
  }
  let match = statement.match(createTable) ?? statement.match(alterTable)
  if (match) trackReferences(statement, tableKey(match[2] ?? match[1]!), tables)
  match = statement.match(createTable)
  if (match) {
    if (tables.dialect === "sqlite"
      && (/^CREATE\s+TEMP(?:ORARY)?\s+TABLE\b/i.test(statement) || tableKey(match[2]!).toLowerCase().startsWith("temp."))) {
      // Without resolving SQLite schemas, later names could refer to older permanent tables.
      noOlderRows.clear()
      tables.temporaryTableSeen = true
      return
    }
    // With IF NOT EXISTS, an older table keeps its rows. A table that this run dropped is new again.
    if (!match[1]) {
      const table = tableKey(match[2]!)
      if (readsOnlyNewRows(statement.slice(match[0].length))) add(table)
      else forget(table)
    }
    return
  }
  if ((match = statement.match(renameTo))) {
    const from = tableKey(match[1]!)
    const target = tableKey(match[2]!)
    const schema = from.match(new RegExp(String.raw`^(${identifier})\.`))?.[1]
    const to = schema && !schemaQualifiedTable.test(target) ? `${schema}.${target}` : target
    if (noOlderRows.has(from)) add(to)
    else forget(to)
    add(from)
    renameReferences(from, to, tables)
    if (tables.deleteOrUpdateTriggers.has(referenceKey(from, tables))) tables.deleteOrUpdateTriggers.add(referenceKey(to, tables))
    return
  }
  if ((match = statement.match(dropTable))) {
    for (const [name] of match[1]!.matchAll(new RegExp(qualifiedName, "g"))) add(tableKey(name))
    return
  }
  if ((match = statement.match(writeInto))) {
    if (!readsOnlyNewRows()) forget(tableKey(match[1]!))
    return
  }
  // Schema moves can replace a tracked identity; partitions and inheritance can expose older descendants.
  if (setSchema.test(statement) || (/^ALTER\s+TABLE\b/i.test(statement)
    && (hasKeywordOutsideQuotes(statement, "ATTACH") || hasKeywordOutsideQuotes(statement, "INHERIT")))) noOlderRows.clear()
  // A `WITH` query, a function, or another statement that ViteHub does not read could copy older rows anywhere.
  if (!keepsRows.test(statement)) noOlderRows.clear()
}

/**
 * Removes the data loss on tables that an earlier statement of the same run created or dropped, because those tables
 * hold no rows from before the run. `migrations` are the pending migrations in the order they run. A table that gets
 * rows copied from an older table, like a SQLite rebuild of an existing table, keeps its data loss. So does a table that
 * a table with older rows references with a foreign key that this run declares, because a drop runs its ON DELETE
 * action. SQLite triggers on affected tables can also change older rows. A foreign key from before the run counts
 * when the snapshot lists it, see `findDataLoss()`. PostgreSQL names
 * must be schema-qualified because the search path can resolve the same unqualified name to different tables.
 */
export function withoutNewTableDataLoss<T extends DataLossMigration>(migrations: readonly T[], dialect: DatabaseDialect = "sqlite"): T[] {
  const tables: NewTables = { deleteOrUpdateTriggers: new Set(), dialect, fedByTrigger: new Set(), inTrigger: false, noOlderRows: new Set(), referencedBy: new Map(), temporaryTableSeen: false, unknownTriggerSeen: false }
  return migrations.map((migration) => {
    const losses = [...migration.dataLoss]
    const dataLoss: DataLossStatement[] = []
    for (const statement of migration.statements.flatMap(part => splitSqlStatements(part, dialect))) {
      if (losses[0]?.statement === statement) {
        const loss = losses.shift()!
        const dropping = statement.match(dropTable)?.[1]
        const dropped = dropping || deleteFrom.test(statement)
          ? new Set([...dropping?.matchAll(new RegExp(qualifiedName, "g")) ?? []].map(([name]) => referenceKey(tableKey(name), tables)))
          : undefined
        if (!loss.tables?.length || !loss.tables.every(table => holdsNoOlderRows(table, tables, dropped))) dataLoss.push(loss)
      }
      trackNewTables(statement, tables)
    }
    return { ...migration, dataLoss: [...dataLoss, ...losses] }
  })
}
