/** A statement in a pending migration that removes data. */
export interface DataLossStatement {
  reason: string
  statement: string
  /** The tables that lose data. Empty or missing when the loss is wider than tables, like `DROP SCHEMA`. */
  tables?: string[]
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

/** Names a table the same way in every statement: unquoted parts in lower case, quoted parts as written. */
function tableKey(name: string): string {
  return [...name.matchAll(new RegExp(identifier, "g"))].map(([part]) => /^["`[]/.test(part) ? unquote(part) : part.toLowerCase()).join(".")
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
 * Lists the statements of one migration that remove rows, columns, or tables.
 * `before` holds the columns of each table before the migration, so a SQLite table rebuild that keeps every column is safe.
 */
export function findDataLoss(statements: readonly string[], before?: TableColumns): DataLossStatement[] {
  const split = statements.flatMap(splitSqlStatements)
  const rebuilds = findRebuilds(split)
  const found: DataLossStatement[] = []
  for (const statement of split) {
    const loss = classifyStatement(statement, rebuilds, before)
    if (loss) found.push({ ...loss, statement })
  }
  return found
}

function classifyStatement(statement: string, rebuilds: ReadonlyMap<string, Rebuild>, before: TableColumns | undefined): Omit<DataLossStatement, "statement"> | undefined {
  let match = statement.match(dropTable)
  if (match) {
    const losses = [...match[1]!.matchAll(new RegExp(qualifiedName, "g"))].flatMap(([name]) => {
      const table = unquote(name)
      const rebuild = rebuilds.get(table.toLowerCase())
      const reason = rebuild ? describeRebuild(table, rebuild, before) : `drops table "${table}"`
      return reason ? [{ reason, table: tableKey(name) }] : []
    })
    return losses.length ? { reason: losses.map(loss => loss.reason).join("; "), tables: losses.map(loss => loss.table) } : undefined
  }
  if ((match = statement.match(alterDrop))) return { reason: `drops column "${unquote(match[2]!)}" from "${unquote(match[1]!)}"`, tables: [tableKey(match[1]!)] }
  if ((match = statement.match(truncate))) {
    const names = [...match[1]!.matchAll(new RegExp(truncateTarget, "gi"))].map(target => target[1]!)
    return { reason: names.map(name => `deletes every row of "${unquote(name)}"`).join("; "), tables: names.map(tableKey) }
  }
  if ((match = statement.match(deleteFrom)) && !hasKeywordOutsideQuotes(statement, "WHERE")) return { reason: `deletes every row of "${unquote(match[1]!)}"`, tables: [tableKey(match[1]!)] }
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

const createTable = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(${qualifiedName})`, "i")
const renameTo = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${qualifiedName})\s+RENAME\s+TO\s+(${qualifiedName})`, "i")
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
  /** Tables that hold only rows written by this run, or that this run dropped. */
  noOlderRows: Set<string>
  /** Tables that a trigger writes into. A later write to another table can copy older rows into them. */
  fedByTrigger: Set<string>
  /** True between `CREATE TRIGGER` and its `END`, which the statement split cuts into parts. */
  inTrigger: boolean
}

const createTrigger = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i

function feedByTrigger(statement: string, tables: NewTables) {
  const match = statement.match(writeInto)
  if (!match) return
  tables.fedByTrigger.add(tableKey(match[1]!))
  tables.noOlderRows.delete(tableKey(match[1]!))
}

/** Updates the tables that hold no rows from before this run of migrations, after a statement runs. */
function trackNewTables(statement: string, tables: NewTables) {
  const { noOlderRows } = tables
  if (tables.inTrigger) {
    if (/^END\b/i.test(statement)) tables.inTrigger = false
    else feedByTrigger(statement, tables)
    return
  }
  if (createTrigger.test(statement)) {
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
    if (!tables.fedByTrigger.has(table)) noOlderRows.add(table)
  }
  let match = statement.match(createTable)
  if (match) {
    // With IF NOT EXISTS, an older table keeps its rows. A table that this run dropped is new again.
    if (!match[1]) {
      const table = tableKey(match[2]!)
      if (readsOnlyNewRows(statement.slice(match[0].length))) add(table)
      else noOlderRows.delete(table)
    }
    return
  }
  if ((match = statement.match(renameTo))) {
    const from = tableKey(match[1]!)
    const to = tableKey(match[2]!)
    if (noOlderRows.has(from)) add(to)
    else noOlderRows.delete(to)
    add(from)
    return
  }
  if ((match = statement.match(dropTable))) {
    for (const [name] of match[1]!.matchAll(new RegExp(qualifiedName, "g"))) add(tableKey(name))
    return
  }
  if ((match = statement.match(writeInto))) {
    if (!readsOnlyNewRows()) noOlderRows.delete(tableKey(match[1]!))
    return
  }
  // Attaching a partition can expose older rows through this table and any of its partition ancestors.
  if (/^ALTER\s+TABLE\b/i.test(statement) && hasKeywordOutsideQuotes(statement, "ATTACH")) noOlderRows.clear()
  // A `WITH` query, a function, or another statement that ViteHub does not read could copy older rows anywhere.
  if (!keepsRows.test(statement)) noOlderRows.clear()
}

/**
 * Removes the data loss on tables that an earlier statement of the same run created or dropped, because those tables
 * hold no rows from before the run. `migrations` are the pending migrations in the order they run. A table that gets
 * rows copied from an older table, like a SQLite rebuild of an existing table, keeps its data loss.
 */
export function withoutNewTableDataLoss<T extends DataLossMigration>(migrations: readonly T[]): T[] {
  const tables: NewTables = { fedByTrigger: new Set(), inTrigger: false, noOlderRows: new Set() }
  return migrations.map((migration) => {
    const losses = [...migration.dataLoss]
    const dataLoss: DataLossStatement[] = []
    for (const statement of migration.statements.flatMap(splitSqlStatements)) {
      if (losses[0]?.statement === statement) {
        const loss = losses.shift()!
        if (!loss.tables?.length || !loss.tables.every(table => tables.noOlderRows.has(table))) dataLoss.push(loss)
      }
      trackNewTables(statement, tables)
    }
    return { ...migration, dataLoss: [...dataLoss, ...losses] }
  })
}
