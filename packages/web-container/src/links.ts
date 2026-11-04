// Shared by the Node snapshot builder and the browser, so this file imports nothing.

/** The file in `node_modules` that lists what a snapshot cannot hold. */
export const snapshotLinksFile = ".vitehub-snapshot-links.json"

export interface SnapshotLinks {
  /** `[path, target]` of each symlink, such as `["node_modules/.bin/vite", "../vite/bin/vite.js"]`. */
  links: [string, string][]
  /** Files that must be executable, such as the ones that `.bin` links point to. */
  executables: string[]
}

/**
 * A Node script that restores the links and executable bits of a mounted snapshot, from the working directory.
 *
 * The snapshot bytes come from the network, so the list is not trusted: a path must be relative and stay inside the
 * working directory, and so must the place that a link points to. Other entries are skipped and printed.
 */
export const restoreLinksScript = [
  `const fs = require("node:fs")`,
  `const path = require("node:path")`,
  `const root = process.cwd()`,
  `const inside = target => target === root || target.startsWith(root + path.sep)`,
  `const local = file => typeof file === "string" && file !== "" && !path.isAbsolute(file) && inside(path.resolve(root, file))`,
  `const { links = [], executables = [] } = JSON.parse(fs.readFileSync(${JSON.stringify(`node_modules/${snapshotLinksFile}`)}, "utf8"))`,
  `const skipped = []`,
  `for (const file of executables) { if (local(file)) fs.chmodSync(file, 0o755); else skipped.push(file) }`,
  `for (const [file, target] of links) {`,
  `  if (!local(file) || typeof target !== "string" || path.isAbsolute(target) || !inside(path.resolve(root, path.dirname(file), target))) { skipped.push(file); continue }`,
  `  try { fs.symlinkSync(target, file) } catch (error) { if (error.code !== "EEXIST") throw error }`,
  `}`,
  `if (skipped.length > 0) console.warn("Skipped snapshot links outside the project: " + skipped.join(", "))`,
].join("\n")

/** True when `target`, relative to the folder of the link at `path`, stays inside the root. Both use `/`. */
export function linkStaysInside(path: string, target: string): boolean {
  if (target.startsWith("/") || path.startsWith("/")) return false
  const segments = [...path.split("/").slice(0, -1), ...target.split("/")]
  let depth = 0
  for (const segment of segments) {
    if (segment === "..") depth--
    else if (segment !== "." && segment !== "") depth++
    if (depth < 0) return false
  }
  return true
}
