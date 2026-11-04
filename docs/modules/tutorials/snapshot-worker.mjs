// Runs in its own Node process, so the snapshot (hundreds of MiB in memory) does not share the heap of the docs build.
//   node snapshot-worker.mjs <app dir> <out dir> <file prefix>
// Prints the written file names as JSON, with the sizes.
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createNodeModulesSnapshot, packSnapshot } from "@vite-hub/web-container/snapshot"

const [dir, outDir, prefix] = process.argv.slice(2)
const snapshot = await createNodeModulesSnapshot({ dir })
const parts = packSnapshot(snapshot)
const hash = createHash("sha256")
for (const part of parts) hash.update(part)
const id = hash.digest("hex").slice(0, 12)
const files = []
for (const [index, part] of parts.entries()) {
  const file = `${prefix}.${id}.${index}.bin`
  await writeFile(resolve(outDir, file), part)
  files.push(file)
}
console.log(JSON.stringify({ files, bytes: snapshot.byteLength, compressed: parts.reduce((total, part) => total + part.byteLength, 0) }))
