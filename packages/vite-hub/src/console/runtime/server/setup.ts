import { installConsoleProjectRoot } from "./project-root.ts"
import { consoleState } from "../../internal.ts"

import type { ConsoleProjectBuild } from "./project.ts"
import type { ConsoleSectionId } from "../sections.ts"

// The generated Console Nitro plugin imports its setters from this entry. It leaves out the access checks and
// Realtime access of the sections module, which load on the first Console request.
export { installConsoleAccess } from "./access-policy.ts"
export { installConsoleDevelopment } from "./development.ts"
export { installConsoleRuntime } from "./runtime.ts"

export function installConsoleSiteDatabase(load: () => Promise<Record<string, { db: object }>>, preferredName?: string): void {
  consoleState().siteDatabase = async () => {
    const databases = await load()
    const name = preferredName ?? Object.keys(databases)[0]
    if (name === undefined) return undefined
    const entry = databases[name]
    return entry && { name, db: entry.db }
  }
}

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], navigationSections?: readonly ConsoleSectionId[]): readonly ConsoleSectionId[] {
  const state = consoleState()
  state.navigationSections = navigationSections ? [...new Set(navigationSections)] : undefined
  return state.sections = [...new Set(sections)]
}

/** Generated production output installs what its build recorded, so `project.get` names the build that serves it. */
export function installConsoleBuild(build: ConsoleProjectBuild): ConsoleProjectBuild {
  return consoleState().build = build
}

/** Generated output installs the `vite-hub` version that the app built with, for `project.get`. */
export function installConsoleVersion(version: string): string {
  return consoleState().vitehub = version
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  installConsoleProjectRoot(projectRoot)
  return consoleState().projectName = projectName
}
