import type { ViteHubDefinitionField, ViteHubDefinitionSummary } from "./inspect.ts"

type MaybePromise<T> = T | Promise<T>

/** Lists discovered Definitions in a sidebar and shows the selected Definition's fields. */
export interface ViteHubConsoleDefinitionCatalogView {
  kind: "definition-catalog"
  /** States which runtime data this catalog does not include. */
  notice: string
}

export interface ViteHubConsoleRecordColumn {
  /** Key in `ViteHubConsoleRecord.cells`. */
  key: string
  label: string
}

/** Shows records in a table and the selected record's fields in a detail panel. */
export interface ViteHubConsoleRecordTableView {
  columns: readonly ViteHubConsoleRecordColumn[]
  kind: "record-table"
  /** States the source and limits of the records. */
  notice: string
}

export type ViteHubConsoleSectionView = ViteHubConsoleDefinitionCatalogView | ViteHubConsoleRecordTableView

/** One serializable record row. Values are display strings. Do not put credentials in records. */
export interface ViteHubConsoleRecord {
  cells: Readonly<Record<string, string>>
  fields: readonly ViteHubDefinitionField[]
  id: string
  /** The Console can run this record when it represents a runnable Schedule Definition. */
  runnable?: boolean
}

/** Serializable description of a Console section. The Console UI in `vite-hub` renders the view. */
export interface ViteHubConsoleSectionDescriptor<TView extends ViteHubConsoleSectionView = ViteHubConsoleSectionView> {
  description: string
  /**
   * Iconify class name, for example `i-ph-tray-light`. Use a collection that `vite-hub` installs (`lucide` or `ph`). The
   * Console build bundles the icon of every section in the `vite-hub` Console registry and fails if it cannot resolve one.
   */
  icon: string
  /** Lowercase route segment, for example `queues`. The Console serves the section at `/_vitehub/<id>`. */
  id: string
  /** Plural display name, for example `Queues`. */
  label: string
  view: TView
}

export interface ViteHubConsoleDefinitionCatalogSection<TOptions = void> extends ViteHubConsoleSectionDescriptor<ViteHubConsoleDefinitionCatalogView> {
  /** Reads the section data on the server. The Console never runs it in the browser. */
  read: (options: TOptions) => MaybePromise<readonly ViteHubDefinitionSummary[]>
}

export interface ViteHubConsoleRecordTableSection<TOptions = void> extends ViteHubConsoleSectionDescriptor<ViteHubConsoleRecordTableView> {
  /** Reads the section data on the server. The Console never runs it in the browser. */
  read: (options: TOptions) => MaybePromise<readonly ViteHubConsoleRecord[]>
}

/**
 * Server module export that returns records on each Console request. The export must be a
 * {@link ViteHubConsoleRuntimeRecordReader}.
 */
export interface ViteHubConsoleRuntimeReader {
  /** Named export of `module`. */
  export: string
  /**
   * Owner package module specifier, for example `@vite-hub/schedule/runtime/console`. The host maps it to the module
   * path that the application can import.
   */
  module: string
}

/** Reads runtime records in the server runtime. It runs on each Console request, never in the browser. */
export type ViteHubConsoleRuntimeRecordReader = () => MaybePromise<readonly ViteHubConsoleRecord[]>

/**
 * A record table that also reads records at request time. The Console shows the build-time records of `read` first,
 * then the records of the `runtime` reader. A runtime record replaces a build-time record with the same id.
 */
export interface ViteHubConsoleRuntimeRecordTableSection<TOptions = void> extends ViteHubConsoleSectionDescriptor<ViteHubConsoleRecordTableView> {
  /** Reads build-time records on the server. When omitted, the section has only runtime records. */
  read?: (options: TOptions) => MaybePromise<readonly ViteHubConsoleRecord[]>
  runtime: ViteHubConsoleRuntimeReader
}

/**
 * A Console section that an owner package contributes. The owner defines the label, icon, view, and data reader.
 * `TOptions` is the discovery context that the host passes to `read`.
 */
export type ViteHubConsoleSectionContribution<TOptions = void> =
  | ViteHubConsoleDefinitionCatalogSection<TOptions>
  | ViteHubConsoleRecordTableSection<TOptions>
  | ViteHubConsoleRuntimeRecordTableSection<TOptions>

export type ViteHubConsoleSectionContent =
  | { definitions: readonly ViteHubDefinitionSummary[], kind: "definition-catalog" }
  | { kind: "record-table", records: readonly ViteHubConsoleRecord[] }

const sectionIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const runtimeModulePattern = /^@vite-hub\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/
const runtimeExportPattern = /^[A-Za-z_$][\w$]*$/

export function isViteHubConsoleSectionId(value: unknown): value is string {
  return typeof value === "string" && sectionIdPattern.test(value)
}

function isDefinitionCatalogSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
): section is ViteHubConsoleDefinitionCatalogSection<TOptions> {
  return section.view.kind === "definition-catalog"
}

/** Returns true when the section also reads records at request time. */
export function isViteHubConsoleRuntimeSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
): section is ViteHubConsoleRuntimeRecordTableSection<TOptions> {
  return "runtime" in section
}

/** Returns a checked copy of the runtime reader of a section, or `undefined` when the section has none. */
export function describeViteHubConsoleRuntimeReader<TOptions>(section: ViteHubConsoleSectionContribution<TOptions>): ViteHubConsoleRuntimeReader | undefined {
  if (!isViteHubConsoleRuntimeSection(section)) return
  const { export: name, module } = section.runtime
  if (!runtimeModulePattern.test(module)) {
    throw new TypeError(`[vitehub] Console section ${JSON.stringify(section.id)} runtime module ${JSON.stringify(module)} must be a @vite-hub package path.`)
  }
  if (!runtimeExportPattern.test(name)) {
    throw new TypeError(`[vitehub] Console section ${JSON.stringify(section.id)} runtime export ${JSON.stringify(name)} must be an identifier.`)
  }
  return { export: name, module }
}

/** Returns the serializable part of a contribution. */
export function describeViteHubConsoleSection<TOptions>(section: ViteHubConsoleSectionContribution<TOptions>): ViteHubConsoleSectionDescriptor {
  if (!isViteHubConsoleSectionId(section.id)) {
    throw new TypeError(`[vitehub] Console section id ${JSON.stringify(section.id)} must be a lowercase route segment.`)
  }
  const view: ViteHubConsoleSectionView = section.view.kind === "definition-catalog"
    ? { kind: "definition-catalog", notice: section.view.notice }
    : { columns: section.view.columns.map(column => ({ key: column.key, label: column.label })), kind: "record-table", notice: section.view.notice }
  return { description: section.description, icon: section.icon, id: section.id, label: section.label, view }
}

/**
 * Runs the owner build-time reader and returns content that matches the section view. For a runtime section, the
 * content holds only the build-time records. The host adds the runtime records on each request.
 */
export async function readViteHubConsoleSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
  options: TOptions,
): Promise<ViteHubConsoleSectionContent> {
  if (isViteHubConsoleRuntimeSection(section)) {
    return { kind: "record-table", records: section.read ? [...await section.read(options)] : [] }
  }
  if (isDefinitionCatalogSection(section)) {
    return { definitions: [...await section.read(options)], kind: "definition-catalog" }
  }
  return { kind: "record-table", records: [...await section.read(options)] }
}
