import { resolve } from "node:path"

import { installConsoleDefinitionScope, resolveConsoleDefinitions } from "../../internal.ts"
import { consoleDefinitionSectionIds } from "../definitions.ts"

import type { ConsoleDefinitionCatalog } from "../definitions.ts"

export function installConsoleDefinitions(
  projectRoot: string,
  catalog: ConsoleDefinitionCatalog,
): ConsoleDefinitionCatalog {
  const installed = Object.fromEntries(
    consoleDefinitionSectionIds
      .filter(section => catalog[section])
      .map(section => [section, catalog[section]?.map(definition => ({
        ...definition,
        fields: definition.fields.map(field => ({ ...field })),
      }))]),
  ) as ConsoleDefinitionCatalog
  return installConsoleDefinitionScope(resolve(projectRoot), installed)
}

export function getConsoleDefinitions(): ConsoleDefinitionCatalog {
  const catalog = resolveConsoleDefinitions()
  if (!catalog) {
    throw new TypeError("[vitehub] Definition inspection has not been installed for this runtime.")
  }
  return catalog
}
