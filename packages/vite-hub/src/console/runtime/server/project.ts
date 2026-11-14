import { allowedConsoleSections, consoleOperationGranted } from "./access.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { consoleOperations } from "./operations.ts"
import { getConsoleBuild, getConsoleProjectName, getConsoleSections } from "./sections.ts"
import { version } from "../../../version.ts"

import type { ConsoleAccess } from "./access.ts"

declare global {
  interface ImportMeta {
    viteHubConsoleOperationSections?: readonly string[]
  }
}

/** What the production build of the app recorded about its source. A development server has none. */
export interface ConsoleProjectBuild {
  /** When the build ran, as an ISO time. */
  time: string
  /** The Git commit of the build, from CI variables or `git`. A build without Git has none. */
  commit?: {
    sha: string
    /** The first line of the commit message. */
    message?: string
    /** The name of the commit author, without the email. */
    author?: string
    branch?: string
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
  /** The production build that serves this answer. */
  build?: ConsoleProjectBuild
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
    // The ViteHub MCP of the Console sees only the operations that MCP clients may call.
    .filter(operation => access.surface !== "mcp" || operation.mcp !== false)
    .map(operation => operation.name)
  const name = getConsoleProjectName()
  const build = getConsoleBuild()
  return { protocol: 1, ...(name ? { name } : {}), vitehub: version, ...(build ? { build } : {}), sections, operations }
}
