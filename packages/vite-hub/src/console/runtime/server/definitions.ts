import { resolve } from "node:path"

import { installConsoleDefinitionScope, resolveConsoleDefinitions } from "../../internal.ts"
import { consoleDefinitionSectionIds } from "../definitions.ts"

import type { ConsoleDefinitionCatalog } from "../definitions.ts"

export function installConsoleDefinitions(
  projectRoot: string,
  catalog: ConsoleDefinitionCatalog,
): ConsoleDefinitionCatalog {
  const installed: ConsoleDefinitionCatalog = {}
  for (const section of consoleDefinitionSectionIds) {
    const definitions = catalog[section]
    if (definitions) {
      installed[section] = definitions.map(definition => ({
        ...definition,
        fields: definition.fields.map(field => ({ ...field })),
      }))
    }
  }
  return installConsoleDefinitionScope(resolve(projectRoot), installed)
}

export function getConsoleDefinitions(): ConsoleDefinitionCatalog {
  const catalog = resolveConsoleDefinitions()
  if (!catalog) {
    throw new TypeError("[vitehub] Definition inspection has not been installed for this runtime.")
  }
  return catalog
}
