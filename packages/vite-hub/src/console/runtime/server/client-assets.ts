/** The hashed entry files of `@vite-hub/console-client`, which the Console serves at `/_vitehub/assets`. */
export interface ConsoleClientAssets {
  /** The Console app script. */
  script: string
  /** The Console app stylesheet. */
  style: string
  /** The `console` page tool script. */
  pageTool: string
}

const assetsKey: unique symbol = Symbol.for("vitehub.console.client-assets")
// SAFETY: The Console adds only optional symbol-keyed state to the global object.
const scope = globalThis as typeof globalThis & { [assetsKey]?: ConsoleClientAssets }

/** Generated Console output installs the entry names that it read from the installed `@vite-hub/console-client`. */
export function installConsoleClient(assets: ConsoleClientAssets): void {
  scope[assetsKey] = assets
}

export function consoleClientAssets(): ConsoleClientAssets | undefined {
  return scope[assetsKey]
}
