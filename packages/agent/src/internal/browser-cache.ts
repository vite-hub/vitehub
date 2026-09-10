import { lstat, readdir, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"

/** Refuse caches another OS user can replace before running their executables. */
export async function assertTrustedBrowserCache(root: string): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("[vitehub] Managed browser cache ownership cannot be verified on this host.")
  const reject = (path: string): never => {
    throw new Error(`[vitehub] Managed browser cache requires trusted ownership and permissions: ${path}`)
  }
  // A root-owned sticky directory such as /tmp cannot replace our owned child.
  for (let path = dirname(root);; path = dirname(path)) {
    const info = await lstat(path)
    if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0)
      || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) reject(path)
    if (dirname(path) === path) break
  }
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.uid !== uid) reject(path)
    if (info.isSymbolicLink()) {
      // npm's command shims are links. Only allow targets in this validated tree.
      const target = relative(root, await realpath(path))
      if (path === root || target === ".." || target.startsWith("../") || isAbsolute(target)) reject(path)
      return
    }
    if ((info.mode & 0o022) !== 0 || (!info.isFile() && !info.isDirectory())) reject(path)
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry))
    }
  }
  try {
    await lstat(root)
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
  await visit(root)
}
