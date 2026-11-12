import { ownModule } from "@vite-hub/internal/build/paths"

/**
 * Modules of this package that only generated code imports. Generated code imports each one by its absolute path, so
 * each is a build entry and not a package export.
 */
export const generatedModules = {
  commentsRealtime: ownModule(import.meta.url, "comments/realtime"),
  commentsRuntimeAuth: ownModule(import.meta.url, "comments/runtime/auth"),
  connectionsAgent: ownModule(import.meta.url, "connections/agent"),
  consoleBlob: ownModule(import.meta.url, "console/runtime/server/blob"),
  consoleDatabase: ownModule(import.meta.url, "console/runtime/server/database"),
  consoleDefinitions: ownModule(import.meta.url, "console/runtime/server/definitions"),
  consoleDocuments: ownModule(import.meta.url, "console/runtime/server/documents"),
  consoleEnv: ownModule(import.meta.url, "console/runtime/server/env"),
  consoleOperations: ownModule(import.meta.url, "console/runtime/server/operation-contributions"),
  consolePageAuth: ownModule(import.meta.url, "console/runtime/server/page-auth"),
  consolePageTool: ownModule(import.meta.url, "console/runtime/server/page-tool"),
  consoleSections: ownModule(import.meta.url, "console/runtime/server/sections"),
  consoleSetup: ownModule(import.meta.url, "console/runtime/server/setup"),
}
