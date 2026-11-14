import { installConsoleProjectRoot } from "./project-root.ts"
import { consoleState } from "../../internal.ts"

import type { ConsoleProjectBuild } from "./project.ts"
import type { ConsoleSectionId } from "../sections.ts"

// The generated Console Nitro plugin imports its setters from this entry. It leaves out the access checks and
// Realtime access of the sections module, which load on the first Console request.
export { installConsoleAccess } from "./access-policy.ts"
export { installConsoleDevelopment } from "./development.ts"
export { installConsoleRuntime } from "./runtime.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], navigationSections?: readonly ConsoleSectionId[]): readonly ConsoleSectionId[] {
  const state = consoleState()
  state.navigationSections = navigationSections ? [...new Set(navigationSections)] : undefined
  return state.sections = [...new Set(sections)]
}

/** Generated production output installs what its build recorded, so `project.get` names the build that serves it. */
export function installConsoleBuild(build: ConsoleProjectBuild): ConsoleProjectBuild {
  return consoleState().build = build
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  installConsoleProjectRoot(projectRoot)
  return consoleState().projectName = projectName
}
