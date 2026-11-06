import { allowedConsoleSections, consoleOperationOffered } from "./access.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { getConsoleProjectName, getConsoleSections } from "./sections.ts"
import { version } from "../../../version.ts"

import type { ConsoleAccess } from "./access.ts"

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
  const operations = consoleOperationRegistry().list()
    // An operation of a section that the app does not install is registered but cannot run.
    .filter(operation => (typeof operation.section !== "string" || installed.includes(operation.section)) && consoleOperationOffered(access, operation))
    .map(operation => operation.name)
  const name = getConsoleProjectName()
  return { protocol: 1, ...(name ? { name } : {}), vitehub: version, sections, operations }
}
