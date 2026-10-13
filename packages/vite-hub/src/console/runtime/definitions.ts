// These types mirror `@vite-hub/internal/console`. Console runtime files ship as source, so they cannot import the
// private internal package. `console/contributions.ts` checks that owner contributions stay assignable to them.

export interface ConsoleDefinitionField {
  label: string
  value: string
}

export interface ConsoleDefinitionSummary {
  fields: readonly ConsoleDefinitionField[]
  file: string
  name: string
  source: string
  /** The Console can run this manual Schedule Definition. */
  runnable?: boolean
}

export interface ConsoleRecordColumn {
  key: string
  label: string
}

export interface ConsoleRecord {
  cells: Readonly<Record<string, string>>
  fields: readonly ConsoleDefinitionField[]
  id: string
  /** The Console can run this record when it represents a runnable Schedule Definition. */
  runnable?: boolean
}

export type ConsoleSectionView =
  | { kind: "definition-catalog", notice: string }
  | { columns: readonly ConsoleRecordColumn[], kind: "record-table", notice: string }

/** Serializable descriptor of a Console section that an owner package contributes. */
export interface ConsoleContributedSection {
  description: string
  icon: string
  id: string
  label: string
  view: ConsoleSectionView
}

export type ConsoleSectionContent =
  | { definitions: readonly ConsoleDefinitionSummary[], kind: "definition-catalog" }
  | { kind: "record-table", records: readonly ConsoleRecord[] }

/** Reads the records of one section on each Console request. It mirrors `ViteHubConsoleRuntimeRecordReader`. */
export type ConsoleRuntimeRecordReader = () => readonly ConsoleRecord[] | Promise<readonly ConsoleRecord[]>

/**
 * Section data for one project: descriptors of contributed sections, the build-time content of each section, and the
 * request-time readers of record-table sections.
 */
export interface ConsoleSectionCatalog {
  content: Readonly<Record<string, ConsoleSectionContent>>
  readers?: Readonly<Record<string, ConsoleRuntimeRecordReader>>
  sections: readonly ConsoleContributedSection[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function text(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  return typeof value === "string"
}

export function parseConsoleDefinitionFields(value: unknown): ConsoleDefinitionField[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const field = record(entry)
    return text(field?.label) && text(field.value) ? [{ label: field.label, value: field.value }] : []
  })
}

function parseConsoleSectionView(value: unknown): ConsoleSectionView | undefined {
  const view = record(value)
  if (!text(view?.notice)) return undefined
  if (view.kind === "definition-catalog") return { kind: "definition-catalog", notice: view.notice }
  if (view.kind !== "record-table" || !Array.isArray(view.columns)) return undefined
  const columns = view.columns.flatMap((entry) => {
    const column = record(entry)
    return text(column?.key) && text(column.label) ? [{ key: column.key, label: column.label }] : []
  })
  return { columns, kind: "record-table", notice: view.notice }
}

/** Reads a contributed section descriptor from untrusted JSON. */
export function parseConsoleContributedSection(value: unknown): ConsoleContributedSection | undefined {
  const section = record(value)
  const view = parseConsoleSectionView(section?.view)
  return section && view && text(section.id) && text(section.label) && text(section.icon) && text(section.description)
    ? { description: section.description, icon: section.icon, id: section.id, label: section.label, view }
    : undefined
}

export function parseConsoleDefinitionSummaries(value: unknown): ConsoleDefinitionSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const definition = record(entry)
    if (!text(definition?.name) || !text(definition.file) || !text(definition.source)) return []
    const parsed: ConsoleDefinitionSummary = {
      fields: parseConsoleDefinitionFields(definition.fields),
      file: definition.file,
      name: definition.name,
      source: definition.source,
    }
    if (definition.runnable === true) parsed.runnable = true
    return [parsed]
  })
}

function parseConsoleRecords(value: unknown): ConsoleRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = record(entry)
    const cells = record(row?.cells)
    if (!row || !cells || !text(row.id)) return []
    return [{
      cells: Object.fromEntries(Object.entries(cells).filter((cell): cell is [string, string] => text(cell[1]))),
      fields: parseConsoleDefinitionFields(row.fields),
      id: row.id,
      runnable: row.runnable === true ? true : undefined,
    }]
  })
}

/** Reads `/api/_vitehub/console/definitions` content for one section, or returns undefined when it does not match. */
export function parseConsoleSectionContent(value: unknown, section: string): ConsoleSectionContent | undefined {
  const source = record(value)
  if (source?.section !== section) return undefined
  if (source.kind === "record-table") {
    return Array.isArray(source.records) ? { kind: "record-table", records: parseConsoleRecords(source.records) } : undefined
  }
  if (source.kind !== undefined && source.kind !== "definition-catalog") return undefined
  return Array.isArray(source.definitions)
    ? { definitions: parseConsoleDefinitionSummaries(source.definitions), kind: "definition-catalog" }
    : undefined
}
