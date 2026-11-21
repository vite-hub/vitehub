import { consoleState } from "../../internal.ts"

import type { OperationContext } from "@vite-hub/internal/operations"

/** Development output also records the project root and the Setup endpoint route; production output never has them. */
export function installConsoleDevelopment(projectRoot: string, development: boolean, setupRoute?: string): void {
  const state = consoleState()
  state.development = development
  state.projectRoot = development ? projectRoot : undefined
  state.setupRoute = development ? setupRoute : undefined
}

/** The `development` and `projectRoot` of an operation call. Only a development build names its project root. */
export function consoleDevelopmentContext(): Pick<OperationContext, "development" | "projectRoot"> {
  const development = isConsoleDevelopmentBuild()
  const { projectRoot } = consoleState()
  return development && projectRoot ? { development, projectRoot } : { development }
}

/** The route of the dev Setup endpoints. Undefined outside a development server. */
export function consoleSetupRoute(): string | undefined {
  return isConsoleDevelopmentBuild() ? consoleState().setupRoute : undefined
}

/** Unconfigured and production output refuse framing, regardless of runtime NODE_ENV. */
export function isConsoleDevelopmentBuild(): boolean {
  return consoleState().development === true
}
