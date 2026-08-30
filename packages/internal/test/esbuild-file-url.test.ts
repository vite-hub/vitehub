import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it } from "vitest"

import { bundleEsmEntry } from "../src/build/esbuild.ts"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) await rm(tempDir, { force: true, recursive: true })
})

it("bundles modules imported through file URLs", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-internal-esbuild-file-url-"))
  const dependency = join(tempDir, "dependency.mjs")
  const entry = join(tempDir, "entry.mjs")
  const outfile = join(tempDir, "bundle.mjs")
  await writeFile(dependency, 'export default "file URL dependency"\n', "utf8")
  await writeFile(entry, `export { default } from ${JSON.stringify(pathToFileURL(dependency).href)}\n`, "utf8")

  await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node" })

  expect(await readFile(outfile, "utf8")).toContain("file URL dependency")
})
