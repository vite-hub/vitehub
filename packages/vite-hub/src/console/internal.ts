import type { ServerEnvDescription } from "@vite-hub/env"
import type { AgentInvocations } from "@vite-hub/agent"
import type { BlobStorage } from "@vite-hub/blob"
import type { RuntimeDatabaseEntry } from "@vite-hub/database"
import type { ConsoleSectionCatalog } from "./runtime/definitions.ts"
import type { ConsoleDocumentEditors } from "./runtime/server/documents.ts"
import type { ConsoleProjectBuild } from "./runtime/server/project.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

export const consoleStateKey: unique symbol = Symbol.for("vitehub.console.state")
/** `@vite-hub/schedule` reads the Schedules that the Console may run from this slot of the global object. */
export const consoleSchedulesKey: unique symbol = Symbol.for("vitehub.console.schedules")

/** The Console reads each database with `db` and lists its tables from `schema`. A Definition is SQLite or Postgres. */
export type ConsoleDatabaseEntry =
  | Pick<RuntimeDatabaseEntry<Record<string, unknown>>, "db" | "schema">
  | {
    // Inspection uses the primary query API, including for standalone Drizzle databases without replicas.
    db: Omit<RuntimeDatabaseEntry<Record<string, unknown>, "postgresql">["db"], "$replica">
    schema: Record<string, unknown>
  }

export interface ConsoleDatabaseInspection {
  databases: Record<string, ConsoleDatabaseEntry>
  names: readonly string[]
}

export interface ConsoleMediaLibrary {
  runConsoleMediaAction: typeof import("./runtime/server/media.ts").runConsoleMediaAction
  uploadConsoleMedia: typeof import("./runtime/server/media.ts").uploadConsoleMedia
}

export interface ConsoleBlobInspection {
  storage: BlobStorage
  stores: readonly string[]
  /** Loads the media library. Only builds with Blob install it, so other builds ship without it. */
  media?: () => Promise<ConsoleMediaLibrary>
}

/**
 * What generated Console output installs: the sections, the project name, and the readers of each
 * section. One server bundle serves one project, so the Console keeps one state and does not key it by project root.
 * The state lives on the global object, because a development server runs server code in more than one Vite module
 * runner, such as the `nitro` and `ssr` environments of a Nitro dev worker. Each runner loads its own copy of the
 * Console modules, and all of them share the global object.
 */
export interface ConsoleState {
  blob?: ConsoleBlobInspection
  /** What the production build recorded about its source. */
  build?: ConsoleProjectBuild
  database?: ConsoleDatabaseInspection
  definitions?: ConsoleSectionCatalog
  /** Whether generated output was created for a development server. */
  development?: boolean
  /** The project root, installed only in development output. */
  projectRoot?: string
  /** The Agent Invocation journal that the Console reads (`installConsoleInvocations()`). */
  invocations?: AgentInvocations
  /** The Setup endpoint route, installed only in development output. */
  setupRoute?: string
  documents?: ConsoleDocumentEditors
  env?: ServerEnvDescription
  projectName?: string
  /** The installed `vite-hub` version, from generated output. */
  vitehub?: string
  sections?: readonly ConsoleSectionId[]
  /** Sections shown in navigation when local operations have more runtime sections installed. */
  navigationSections?: readonly ConsoleSectionId[]
}

export function consoleState(): ConsoleState {
  // SAFETY: Only this module writes the Console state slot of the global object.
  const scope = globalThis as typeof globalThis & { [consoleStateKey]?: ConsoleState }
  return scope[consoleStateKey] ??= {}
}

/** The Agent Invocation journal that the Console reads, when the app has one. */
export function resolveConsoleInvocations(): AgentInvocations | undefined {
  return consoleState().invocations
}

const consoleSuppliedInvocationsKey: unique symbol = Symbol.for("vitehub.console.invocations.supplied")

/**
 * Marks a journal that the Console supplies to discovered Agents through `installConsoleAgentDefinitions()`.
 * It replaces the app-wide Agent journal.
 */
export function markConsoleSuppliedInvocations(invocations: AgentInvocations): void {
  Object.defineProperty(invocations, consoleSuppliedInvocationsKey, { configurable: true, enumerable: false, value: true })
}

/** The Console journal when the Console supplies it. The Console reads every other journal from its owner. */
export function resolveConsoleSuppliedInvocations(): AgentInvocations | undefined {
  const invocations = resolveConsoleInvocations()
  return invocations && Reflect.get(invocations, consoleSuppliedInvocationsKey) === true ? invocations : undefined
}
