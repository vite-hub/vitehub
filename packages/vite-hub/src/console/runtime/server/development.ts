import { consoleState } from "../../internal.ts"

/** Development output also records the Setup endpoint route; production output never contains it. */
export function installConsoleDevelopment(projectRoot: string, development: boolean, setupRoute?: string): void {
  const state = consoleState()
  state.development = development
  state.setupRoute = development ? setupRoute : undefined
}

/** The route of the dev Setup endpoints. Undefined outside a development server. */
export function consoleSetupRoute(): string | undefined {
  return isConsoleDevelopmentBuild() ? consoleState().setupRoute : undefined
}

/** Unconfigured and production output refuse framing, regardless of runtime NODE_ENV. */
export function isConsoleDevelopmentBuild(): boolean {
  return consoleState().development === true
}
