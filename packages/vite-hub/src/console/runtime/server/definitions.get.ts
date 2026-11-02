import { withConsoleAccess, type ConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { readConsoleDocumentSection } from "./documents.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { copyConsoleRecords, getConsoleDefinitions, getConsoleSchedules } from "./definitions.ts"
import { isConsoleSectionId } from "../sections.ts"

import type { ConsoleRecord, ConsoleSectionContent } from "../definitions.ts"
import type { ConsoleSectionId } from "../sections.ts"
import type { ConsoleRequestEvent } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

function requestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_C0001({ message: statusMessage }), { statusCode, statusMessage })
}

async function readRuntimeRecords(reader: () => readonly ConsoleRecord[] | Promise<readonly ConsoleRecord[]>): Promise<ConsoleRecord[]> {
  try {
    return copyConsoleRecords(await reader())
  }
  catch {
    // The reader error can hold runtime details. The Console shows a fixed message.
    throw requestError(503, "Runtime records are unavailable.")
  }
}

/** A runtime cell or field replaces the build-time one with the same key or label. The others stay. */
function updateRecord(build: ConsoleRecord, runtime: ConsoleRecord): ConsoleRecord {
  const fields = [
    ...build.fields.map(field => runtime.fields.find(entry => entry.label === field.label) ?? field),
    ...runtime.fields.filter(field => !build.fields.some(entry => entry.label === field.label)),
  ]
  return { ...build, ...runtime, cells: { ...build.cells, ...runtime.cells }, fields }
}

/** Build-time records come first. A runtime record updates the build-time record with the same id. */
function mergeRecords(build: readonly ConsoleRecord[], runtime: readonly ConsoleRecord[]): ConsoleRecord[] {
  const runtimeById = new Map(runtime.map(record => [record.id, record]))
  const buildIds = new Set(build.map(record => record.id))
  return [
    ...build.map((record) => {
      const update = runtimeById.get(record.id)
      return update ? updateRecord(record, update) : record
    }),
    ...runtime.filter(record => !buildIds.has(record.id)),
  ]
}

function markRunnableSchedules(records: readonly ConsoleRecord[]): ConsoleRecord[] {
  const runnable = getConsoleSchedules()
  // Schedule Definition records use the `definition:` id prefix and have no `kind` cell.
  return records.map(record => record.id.startsWith("definition:") && record.cells.schedule && Object.hasOwn(runnable, record.cells.schedule)
    ? { ...record, runnable: true }
    : record)
}

async function consoleDefinitionsHandler(event: ConsoleRequestEvent, access: ConsoleAccess): Promise<ConsoleSectionContent & {
  section: ConsoleSectionId
}> {
  assertConsoleRequest(event)
  const section = consoleRequestURL(event).searchParams.get("section")
  if (!isConsoleSectionId(section)) {
    throw requestError(400, "A valid definition section is required.")
  }
  const { content: catalog, readers } = getConsoleDefinitions()
  const content = Object.hasOwn(catalog, section) ? catalog[section] : undefined
  if (!content) throw requestError(404, "Definition section not found.")
  // A document editor reads the collections that this user may read on each request.
  if (content.kind === "document-editor") return { ...await readConsoleDocumentSection(section, access, content.setup), kind: "document-editor", section }
  if (section === "schedules" && content.kind === "definition-catalog") {
    const runnable = getConsoleSchedules()
    return {
      ...content,
      definitions: content.definitions.map(definition => Object.hasOwn(runnable, definition.name) ? { ...definition, runnable: true } : definition),
      section,
    }
  }
  const reader = readers && Object.hasOwn(readers, section) ? readers[section] : undefined
  if (content.kind !== "record-table") return { ...content, section }
  const records = reader ? mergeRecords(content.records, await readRuntimeRecords(reader)) : content.records
  return { kind: "record-table", records: section === "schedules" ? markRunnableSchedules(records) : records, section }
}

const guardedHandler: ConsoleAccessRoute<typeof consoleDefinitionsHandler> = withConsoleAccess(consoleDefinitionsHandler, {
  section: event => consoleRequestURL(event).searchParams.get("section") ?? undefined,
})
export default guardedHandler
