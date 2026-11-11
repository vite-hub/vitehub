import { installConsoleProjectRoot } from "./project-root.ts"
import { consoleState } from "../../internal.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleSectionId } from "../sections.ts"

// The generated Console Nitro plugin imports its setters from this entry. It leaves out the access checks and
// sign-in pages of the sections module, which load on the first Console request.
export { installConsoleAccess } from "./access-policy.ts"
export { installConsoleOrigins } from "./cors.ts"
export { installConsoleDevelopment } from "./development.ts"
export { installConsoleRuntime } from "./runtime.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], independentAuth: ConsoleAuthMode | false = false, navigationSections?: readonly ConsoleSectionId[]): readonly ConsoleSectionId[] {
  const state = consoleState()
  state.auth = independentAuth
  state.navigationSections = navigationSections ? [...new Set(navigationSections)] : undefined
  return state.sections = [...new Set(sections)]
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  installConsoleProjectRoot(projectRoot)
  return consoleState().projectName = projectName
}
