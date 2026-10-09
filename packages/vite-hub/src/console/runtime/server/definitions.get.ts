import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
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

/** Build-time records come first. A runtime record replaces the build-time record with the same id. */
function mergeRecords(build: readonly ConsoleRecord[], runtime: readonly ConsoleRecord[]): ConsoleRecord[] {
  const runtimeIds = new Set(runtime.map(record => record.id))
  return [...build.filter(record => !runtimeIds.has(record.id)), ...runtime]
}

function markRunnableSchedules(records: readonly ConsoleRecord[]): ConsoleRecord[] {
  const runnable = getConsoleSchedules()
  return records.map(record => record.cells.kind === "Definition" && record.cells.schedule && Object.hasOwn(runnable, record.cells.schedule)
    ? { ...record, runnable: true }
    : record)
}

async function consoleDefinitionsHandler(event: ConsoleRequestEvent): Promise<ConsoleSectionContent & {
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

const guardedHandler: ConsoleAccessRoute<typeof consoleDefinitionsHandler> = withConsoleAccess(consoleDefinitionsHandler)
export default guardedHandler
