import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import { linkStaysInside, type SnapshotLinks } from "./links.ts"

/** The binary snapshot format that `WebContainer#mount()` reads: msgpack of `{ d: { [name]: { d } | { f: { c } } } }`. */
export type SnapshotTree = Record<string, { d: SnapshotTree } | { f: { c: Uint8Array } }>

/** Reads `dir` into a snapshot tree, one file at a time. Symlinks and executable files go into `links`, relative to `root`. Source maps are left out. */
export async function readTree(root: string, dir: string, links: SnapshotLinks): Promise<SnapshotTree> {
  const tree: SnapshotTree = {}
  // Sorted, so the same files give the same bytes and the same content hash on every build.
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry)
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      const link = relative(root, path).split(sep).join("/")
      const target = await readlink(path)
      // A link that leaves the project would point at the reader's machine layout, or at nothing. Leave it out, and
      // links to nothing too.
      const exists = await stat(path).then(() => true, () => false)
      if (exists && linkStaysInside(link, target.split(sep).join("/"))) links.links.push([link, target])
    }
    else if (stats.isDirectory()) tree[entry] = { d: await readTree(root, path, links) }
    else if (stats.isFile() && !entry.endsWith(".map")) {
      if (stats.mode & 0o111) links.executables.push(relative(root, path).split(sep).join("/"))
      tree[entry] = { f: { c: await readFile(path) } }
    }
  }
  return tree
}
