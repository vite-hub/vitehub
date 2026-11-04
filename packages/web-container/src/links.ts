// Shared by the Node snapshot builder and the browser, so this file imports nothing.

/** The file in `node_modules` that lists what a snapshot cannot hold. */
export const snapshotLinksFile = ".vitehub-snapshot-links.json"

export interface SnapshotLinks {
  /** `[path, target]` of each symlink, such as `["node_modules/.bin/vite", "../vite/bin/vite.js"]`. */
  links: [string, string][]
  /** Files that must be executable, such as the ones that `.bin` links point to. */
  executables: string[]
}

/** A Node script that restores the links and executable bits of a mounted snapshot. */
export const restoreLinksScript = [
  `const fs = require("node:fs")`,
  `const { links, executables } = JSON.parse(fs.readFileSync(${JSON.stringify(`node_modules/${snapshotLinksFile}`)}, "utf8"))`,
  `for (const path of executables) fs.chmodSync(path, 0o755)`,
  `for (const [path, target] of links) { try { fs.symlinkSync(target, path) } catch (error) { if (error.code !== "EEXIST") throw error } }`,
].join("\n")
