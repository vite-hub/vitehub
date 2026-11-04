import { isWebContainer as detectWebContainer } from "@webcontainer/env"

/**
 * Returns true when this code runs inside a StackBlitz WebContainer.
 *
 * Primitive packages use it to pick a local driver that works there, for example libSQL instead of `node:sqlite`.
 */
export function isWebContainer(): boolean {
  return detectWebContainer()
}
