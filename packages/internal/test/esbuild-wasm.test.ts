import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it } from "vitest"

import { bundleEsmEntry } from "../src/build/esbuild.ts"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) await rm(tempDir, { force: true, recursive: true })
})

it("bundles a WebAssembly module import as its bytes", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-internal-esbuild-wasm-"))
  const entry = join(tempDir, "entry.mjs")
  const outfile = join(tempDir, "bundle.mjs")
  // The smallest valid WebAssembly module: the magic number and version 1.
  await writeFile(join(tempDir, "empty.wasm"), new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]))
  await writeFile(entry, 'export { default } from "./empty.wasm?module"\n', "utf8")

  await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node" })

  const { default: bytes } = await import(pathToFileURL(outfile).href) as { default: unknown }
  expect(bytes).toBeInstanceOf(Uint8Array)
  await expect(WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>)).resolves.toBeInstanceOf(WebAssembly.Module)
})

it("keeps a WebAssembly module import next to a bundle for other targets", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-internal-esbuild-wasm-"))
  const entry = join(tempDir, "entry.mjs")
  const outfile = join(tempDir, "out/bundle.mjs")
  await writeFile(join(tempDir, "empty.wasm"), new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]))
  await writeFile(entry, 'export const load = () => import("./empty.wasm?module")\n', "utf8")

  await bundleEsmEntry(entry, outfile, { format: "esm", platform: "neutral" })

  const [file] = (await readdir(join(tempDir, "out"))).filter(name => name.endsWith(".wasm"))
  expect(file).toMatch(/^empty-[\da-f]{8}\.wasm$/)
  expect(await readFile(outfile, "utf8")).toContain(`import("./${file}")`)
})
