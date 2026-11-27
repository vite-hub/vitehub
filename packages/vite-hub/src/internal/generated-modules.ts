import { ownModule } from "@vite-hub/internal/build/paths"

/**
 * Modules of this package that only generated code imports. Generated code imports each one by its absolute path, so
 * each is a build entry and not a package export.
 */
export const generatedModules = {
  commentsRealtime: ownModule(import.meta.url, "comments/realtime"),
  commentsRuntimeAuth: ownModule(import.meta.url, "comments/runtime/auth"),
  connectionsAgent: ownModule(import.meta.url, "connections/agent"),
  consoleAgent: ownModule(import.meta.url, "console/runtime/server/agent-console"),
  consoleAgentOperations: ownModule(import.meta.url, "agent/console/operations"),
  consoleAuthOperations: ownModule(import.meta.url, "auth/console/operations"),
  consoleBlob: ownModule(import.meta.url, "console/runtime/server/blob"),
  consoleDatabase: ownModule(import.meta.url, "console/runtime/server/database"),
  consoleDatabaseOperations: ownModule(import.meta.url, "database/console/operations"),
  consoleDefinitions: ownModule(import.meta.url, "console/runtime/server/definitions"),
  consoleDocumentOperations: ownModule(import.meta.url, "content/console/operations"),
  consoleDocuments: ownModule(import.meta.url, "console/runtime/server/documents"),
  consoleEnv: ownModule(import.meta.url, "console/runtime/server/env"),
  consoleEnvOperations: ownModule(import.meta.url, "env/console/operations"),
  consoleLogsOperations: ownModule(import.meta.url, "logs/console/operations"),
  consoleMediaOperations: ownModule(import.meta.url, "blob/console/operations"),
  consoleOperations: ownModule(import.meta.url, "console/runtime/server/operation-contributions"),
  consolePill: ownModule(import.meta.url, "console/runtime/server/pill"),
  consoleSections: ownModule(import.meta.url, "console/runtime/server/sections"),
  consoleSetup: ownModule(import.meta.url, "console/runtime/server/setup"),
  consoleSiteAccessOperations: ownModule(import.meta.url, "console/runtime/server/site-access-operation"),
  consoleWorkspaceOperations: ownModule(import.meta.url, "workspace/console/operations"),
  consoleSiteVisitor: ownModule(import.meta.url, "console/runtime/server/site-visitor"),
}
