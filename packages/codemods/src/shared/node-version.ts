import { lt } from "semver"

/** The lowest Node.js version in the `engines` of the `vite-hub` package that a migrated app installs. */
export const viteHubNodeFloor = "24.15.0"

/** Tells that the migrated app cannot run on this Node.js version, or returns `undefined` when it can. */
export function nodeVersionNote(version: string = process.versions.node): string | undefined {
  if (!lt(version, viteHubNodeFloor)) return
  return `vite-hub needs Node 24.15+; this shell runs ${version}. Switch to Node 24.15 or later before you install and run the migrated app.`
}
