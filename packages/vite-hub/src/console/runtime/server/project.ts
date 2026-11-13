import { allowedConsoleSections, consoleOperationGranted } from "./access.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { consoleOperations } from "./operations.ts"
import { getConsoleProjectName, getConsoleSections } from "./sections.ts"
import { version } from "../../../version.ts"

import type { ConsoleAccess } from "./access.ts"

declare global {
  interface ImportMeta {
    viteHubConsoleOperationSections?: readonly string[]
  }
}

/** The answer of `project.get`: what this project runs, and what this caller may use in it. */
export interface ConsoleProject {
  /** The version of this answer. A Console stops when the major version is one that it does not know. */
  protocol: 1
  /** The project name of the Console, from the app's `package.json` or its folder. */
  name?: string
  /** The `vite-hub` version that the app runs. */
  vitehub: string
  /** The installed Console sections that the caller may open. */
  sections: string[]
  /** The installed operations that the caller may call. Each call checks its section again. */
  operations: string[]
}

/** Describe the project for one Console access. `console.authorize` limits the sections and the operations. */
export function readConsoleProject(access: ConsoleAccess): ConsoleProject {
  const installed = getConsoleSections()
  const sections = allowedConsoleSections(access, installed)
  const operationSections = import.meta.viteHubConsoleOperationSections ?? installed
  const operations = consoleOperationRegistry().list()
    // Contributions are installed by registration, including sections without a page. Built-ins need their feature.
    .filter(operation => !consoleOperations.includes(operation) || typeof operation.section !== "string" || operationSections.includes(operation.section))
    .filter(operation => consoleOperationGranted(access, operation))
    .map(operation => operation.name)
  const name = getConsoleProjectName()
  return { protocol: 1, ...(name ? { name } : {}), vitehub: version, sections, operations }
}
