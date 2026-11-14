import { allowedConsoleSections, consoleOperationGranted } from "./access.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { consoleOperations } from "./operations.ts"
import { getConsoleBuild, getConsoleProjectName, getConsoleSections } from "./sections.ts"
import { consoleState } from "../../internal.ts"
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
  /** The Comments of the app, when the caller may open the Comments section. */
  comments?: { open: number }
  /** The installed Console sections that the caller may open. */
  sections: string[]
  /** The installed operations that the caller may call. Each call checks its section again. */
  operations: string[]
}

/** Describe the project for one Console access. `console.authorize` limits the sections and the operations. */
export async function readConsoleProject(access: ConsoleAccess): Promise<ConsoleProject> {
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
  const comments = sections.includes("comments") ? await countOpenComments() : undefined
  return { protocol: 1, ...(name ? { name } : {}), vitehub: version, ...(build ? { build } : {}), ...(comments ? { comments } : {}), sections, operations }
}

/**
 * The open threads of the Comments section, from the same reader as its table, so the Console Home shows the count
 * without one more request per app. A reader that fails gives no count, and the answer still describes the project.
 */
async function countOpenComments(): Promise<{ open: number } | undefined> {
  const reader = consoleState().definitions?.readers?.comments
  if (!reader) return undefined
  try {
    const records = await reader()
    return { open: records.filter(record => record.cells.status === "Open").length }
  }
  catch {
    return undefined
  }
}
