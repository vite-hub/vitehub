import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

export { commentsConsoleSection } from "./console.ts"

export const COMMENTS_VITE_PLUGIN_NAME = "@vite-hub/comments/vite"

function candidates(projectRoot: string, serverDirs: readonly string[] | undefined): string[] {
  const directories = serverDirs === undefined ? [resolve(projectRoot, "server")] : serverDirs.map(directory => resolve(projectRoot, directory))
  return directories.flatMap(directory => ["comments.ts", "comments.mts", "comments.js", "comments.mjs"].map(name => join(directory, name)))
}

/** The `server/comments.{ts,js}` file of the project, or undefined. */
export function findCommentsEntry(options: { projectRoot: string, serverDirs?: readonly string[] }): string | undefined {
  return candidates(options.projectRoot, options.serverDirs).find(file => existsSync(file))
}

/** Whether the project has a `server/comments.ts`. `vitehub()` reads it while Vite filters plugins. */
export function usesComments(options: { projectRoot: string, serverDirs?: readonly string[] }): boolean {
  return findCommentsEntry(options) !== undefined
}
