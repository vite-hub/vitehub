import { runOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { allowedConsoleSections, consoleOperationGranted, readConsoleOperationUser } from "./access.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { consoleOperations } from "./operations.ts"
import { getConsoleBuild, getConsoleProjectName, getConsoleSections } from "./sections.ts"
import { consoleState } from "../../internal.ts"

import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { OperationContext } from "@vite-hub/internal/operations"
import type { ConsoleAccess } from "./access.ts"
import type { ConsoleSectionsResponse } from "./sections.get.ts"

declare global {
  interface ImportMeta {
    viteHubConsoleOperationSections?: readonly string[]
  }
}

/** What the production build of the app recorded about its source. A development server has none. */
export interface ConsoleProjectBuild {
  /** When the build ran, as an ISO time. */
  time: string
  /** The host that the build targets, and the Nitro preset that ViteHub builds with for it. */
  host?: { name: ViteHubHost, preset: string }
  /** The framework that built the app, and its installed version. */
  framework?: { name: "nitro" | "nuxt", version?: string }
  /** The Git commit of the build, from CI variables or `git`. A build without Git has none. */
  commit?: {
    sha: string
    /** The first line of the commit message. */
    message?: string
    /** The name of the commit author, without the email. */
    author?: string
    /** The GitHub login of the commit author, so the Console shows the author's avatar. */
    login?: string
    branch?: string
    /** The github.com repository of the commit, as `owner/name`, so the Console can compare the commit with the default branch. */
    repository?: string
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
  /**
   * What the Console page shows in its rail and Overview, the answer of `sections.list`, so the page opens the project
   * with one call. The CLI and the ViteHub MCP do not get it.
   */
  navigation?: ConsoleSectionsResponse
}

/**
 * Describe the project for one Console access. `console.authorize` limits the sections and the operations. With
 * `navigation`, the answer also has the sections that the Console page shows.
 */
export async function readConsoleProject(context: OperationContext & { access: ConsoleAccess }, options: { navigation?: boolean } = {}): Promise<ConsoleProject> {
  const { access } = context
  const installed = getConsoleSections()
  const sections = allowedConsoleSections(access, installed)
  const operationSections = import.meta.viteHubConsoleOperationSections ?? installed
  const registry = consoleOperationRegistry()
  const operations = registry.list()
    // Contributions are installed by registration, including sections without a page. Built-ins need their feature.
    .filter(operation => !consoleOperations.includes(operation) || typeof operation.section !== "string" || operationSections.includes(operation.section))
    .filter(operation => consoleOperationGranted(access, operation))
    // The ViteHub MCP of the Console sees only the operations that MCP clients may call.
    .filter(operation => access.surface !== "mcp" || operation.mcp !== false)
    .map(operation => operation.name)
  const name = getConsoleProjectName()
  const build = getConsoleBuild()
  const navigation = options.navigation ? await (await import("./sections.get.ts")).listConsoleSections(access) : undefined
  const comments = sections.includes("comments") && operations.includes("comments.list")
    ? await countOpenComments(registry, context)
    : undefined
  return { protocol: 1, ...(name ? { name } : {}), vitehub: consoleState().vitehub ?? "0.0.0", ...(build ? { build } : {}), ...(comments ? { comments } : {}), sections, operations, ...(navigation ? { navigation } : {}) }
}

/**
 * Use the same list operation and caller as the inbox. If the list fails, the answer still describes the project.
 */
async function countOpenComments(registry: ReturnType<typeof consoleOperationRegistry>, context: OperationContext & { access: ConsoleAccess }): Promise<{ open: number } | undefined> {
  const user = context.user ?? await readConsoleOperationUser(context.access) ?? null
  const result = await runOperation(registry, "comments.list", { limit: 500 }, { ...context, user })
  if (!result.ok) return undefined
  const threads = v.safeParse(v.array(v.object({ status: v.string() })), result.value)
  if (threads.success) return { open: threads.output.filter(thread => thread.status === "open").length }
}
