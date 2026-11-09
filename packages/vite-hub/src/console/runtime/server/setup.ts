import { installConsoleProjectRoot } from "./project-root.ts"
import { installConsoleBuildScope, installConsoleProjectNameScope, installConsoleSectionScope } from "../../internal.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleSectionId } from "../sections.ts"

// The generated Console Nitro plugin imports its setters from this entry. It leaves out the access checks and
// sign-in pages of `vite-hub/console/sections`, which load on the first Console request.
export { installConsoleAccess } from "./access-policy.ts"
export { installConsoleOrigins } from "./cors.ts"
export { installConsoleDevelopment } from "./development.ts"
export { installConsolePageTool } from "./page-tool.ts"
export { installConsoleRuntime } from "./runtime.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], independentAuth: ConsoleAuthMode | false = false): readonly ConsoleSectionId[] {
  return installConsoleSectionScope(projectRoot, sections, undefined, independentAuth)
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  installConsoleProjectRoot(projectRoot)
  return installConsoleProjectNameScope(projectRoot, projectName)
}

/**
 * Install the build id of the generated Console output. It changes when the Console catalog or the Console client
 * changes, so an open Console compares it to know that a newer Console is deployed.
 */
export function installConsoleBuild(projectRoot: string, build: string): string {
  return installConsoleBuildScope(projectRoot, build)
}
