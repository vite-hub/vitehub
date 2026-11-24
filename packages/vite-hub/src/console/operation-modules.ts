import { generatedModules } from "../internal/generated-modules.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"

/** What decides that the generated Console app module registers the operations of one module. */
export interface ConsoleOperationModuleFeatures {
  /** The sections whose operations the app serves. */
  sections: readonly string[]
  /** Whether a document editor section exists. */
  documents: boolean
  /** Whether the app has the Site access section. */
  site: boolean
}

/** One module of Console operations. The generated Console app module imports it lazily, only when `enabled` is true. */
export interface ConsoleOperationModule {
  export: string
  module: string
  enabled: (features: ConsoleOperationModuleFeatures) => boolean
  load: () => Promise<readonly AnyOperation[]>
}

/** The Console operations that `vite-hub` owns, one module per primitive. The glue operations are in `consoleOperations`. */
export const consoleOperationModules: readonly ConsoleOperationModule[] = [
  { export: "agentConsoleOperations", module: generatedModules.consoleAgentOperations, enabled: ({ sections }) => sections.includes("agents"), load: async () => (await import("../agent/console/operations.ts")).agentConsoleOperations },
  { export: "authConsoleOperations", module: generatedModules.consoleAuthOperations, enabled: ({ sections }) => sections.includes("auth"), load: async () => (await import("../auth/console/operations.ts")).authConsoleOperations },
  { export: "databaseConsoleOperations", module: generatedModules.consoleDatabaseOperations, enabled: ({ sections }) => sections.includes("databases"), load: async () => (await import("../database/console/operations.ts")).databaseConsoleOperations },
  { export: "documentConsoleOperations", module: generatedModules.consoleDocumentOperations, enabled: ({ documents }) => documents, load: async () => (await import("../content/console/operations.ts")).documentConsoleOperations },
  { export: "envConsoleOperations", module: generatedModules.consoleEnvOperations, enabled: ({ sections }) => sections.includes("env"), load: async () => (await import("../env/console/operations.ts")).envConsoleOperations },
  { export: "logsConsoleOperations", module: generatedModules.consoleLogsOperations, enabled: ({ sections }) => sections.includes("logs"), load: async () => (await import("../logs/console/operations.ts")).logsConsoleOperations },
  { export: "mediaConsoleOperations", module: generatedModules.consoleMediaOperations, enabled: ({ documents, sections }) => documents && sections.includes("blob"), load: async () => (await import("../blob/console/operations.ts")).mediaConsoleOperations },
  { export: "siteAccessOperations", module: generatedModules.consoleSiteAccessOperations, enabled: ({ site }) => site, load: async () => (await import("./runtime/server/site-access-operation.ts")).siteAccessOperations },
  { export: "workspaceConsoleOperations", module: generatedModules.consoleWorkspaceOperations, enabled: ({ sections }) => sections.includes("workspaces"), load: async () => (await import("../workspace/console/operations.ts")).workspaceConsoleOperations },
]

/** Every Console operation that `vite-hub` owns, for the CLI and the build checks. */
export async function loadConsoleOperations(): Promise<AnyOperation[]> {
  const { consoleOperations } = await import("./runtime/server/operations.ts")
  const modules = await Promise.all(consoleOperationModules.map(entry => entry.load()))
  return [...consoleOperations, ...modules.flat()]
}
