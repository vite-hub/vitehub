import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { getConsoleDefinitions } from "./definitions.ts"
import { isConsoleDefinitionSectionId } from "../definitions.ts"

import type { ConsoleDefinitionSectionId, ConsoleDefinitionSummary } from "../definitions.ts"
import type { ConsoleRequestEvent } from "./request.ts"

function requestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(new Error(statusMessage), { statusCode, statusMessage })
}

export default function consoleDefinitionsHandler(event: ConsoleRequestEvent): {
  definitions: readonly ConsoleDefinitionSummary[]
  section: ConsoleDefinitionSectionId
} {
  assertConsoleRequest(event)
  const section = consoleRequestURL(event).searchParams.get("section")
  if (!isConsoleDefinitionSectionId(section)) {
    throw requestError(400, "A valid definition section is required.")
  }
  const definitions = getConsoleDefinitions()[section]
  if (!definitions) throw requestError(404, "Definition section not found.")
  return { definitions, section }
}
