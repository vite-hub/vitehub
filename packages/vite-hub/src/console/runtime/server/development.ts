import { consoleState } from "../../internal.ts"

/** Generated output records whether it was created for a development server. */
export function installConsoleDevelopment(projectRoot: string, development: boolean): void {
  consoleState().development = development
}

/** Unconfigured and production output refuse framing, regardless of runtime NODE_ENV. */
export function isConsoleDevelopmentBuild(): boolean {
  return consoleState().development === true
}
