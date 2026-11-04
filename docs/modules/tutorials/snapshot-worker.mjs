// Runs in its own Node process, so the snapshot (hundreds of MiB in memory) does not share the heap of the docs build.
//   node snapshot-worker.mjs <app dir> <out dir> <file prefix> <lockfile>
// Prints the written file names as JSON, with the SHA-256 of the joined parts and the sizes.
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createNodeModulesSnapshot, packSnapshot } from "@vite-hub/web-container/snapshot"

const [dir, outDir, prefix, lockPath] = process.argv.slice(2)
// The lockfile pins every version, so two builds of one commit give the same bytes.
const lockfile = await readFile(lockPath, "utf8").catch(() => undefined)
let result
try {
  result = await createNodeModulesSnapshot({ dir, lockfile })
}
catch (error) {
  if (lockfile === undefined) throw error
  // The dependencies changed since the lockfile was written. Update it, keeping the versions that still fit.
  console.warn(`[tutorials] ${lockPath} does not match the dependencies (${error.message.split("\n")[0]}). Updating it; commit the change.`)
  result = await createNodeModulesSnapshot({ dir, lockfile, frozenLockfile: false })
}
if (result.lockfile !== lockfile) {
  await mkdir(dirname(lockPath), { recursive: true })
  await writeFile(lockPath, result.lockfile)
  console.warn(`[tutorials] Wrote ${lockPath}. Commit it, so the next build installs the same versions.`)
}
const parts = packSnapshot(result.snapshot)
const hash = createHash("sha256")
for (const part of parts) hash.update(part)
const sha256 = hash.digest("hex")
const files = []
for (const [index, part] of parts.entries()) {
  const file = `${prefix}.${sha256.slice(0, 12)}.${index}.bin`
  await writeFile(resolve(outDir, file), part)
  files.push(file)
}
console.log(JSON.stringify({ files, sha256, bytes: result.snapshot.byteLength, compressed: parts.reduce((total, part) => total + part.byteLength, 0) }))
