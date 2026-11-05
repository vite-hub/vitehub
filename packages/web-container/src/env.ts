/**
 * Returns true when this code runs inside a StackBlitz WebContainer.
 *
 * Primitive packages use it to pick a local driver that works there, for example libSQL instead of `node:sqlite`.
 * WebContainers set `process.versions.webcontainer`. `@webcontainer/env` reads the same field after it requires a
 * StackBlitz-only module, which a Worker bundle cannot leave external, so server code that imports this stays bundleable.
 */
export function isWebContainer(): boolean {
  return typeof process !== "undefined" && process.versions?.webcontainer != null
}
