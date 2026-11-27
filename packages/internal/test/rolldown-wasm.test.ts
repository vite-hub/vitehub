import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it } from "vitest"

import { bundleEsmEntry } from "../src/build/rolldown.ts"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) await rm(tempDir, { force: true, recursive: true })
})

it("bundles a WebAssembly module import as its bytes", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-internal-rolldown-wasm-"))
  const entry = join(tempDir, "entry.mjs")
  const outfile = join(tempDir, "bundle.mjs")
  await writeFile(join(tempDir, "empty.wasm"), new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]))
  await writeFile(entry, 'export { default } from "./empty.wasm?module"\n', "utf8")

  await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node" })

  const { default: bytes } = await import(pathToFileURL(outfile).href) as { default: unknown }
  expect(bytes).toBeInstanceOf(Uint8Array)
  await expect(WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>)).resolves.toBeInstanceOf(WebAssembly.Module)
})

it("keeps a WebAssembly module import next to a bundle for other targets", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-internal-rolldown-wasm-"))
  const entry = join(tempDir, "entry.mjs")
  const outfile = join(tempDir, "out/bundle.mjs")
  await writeFile(join(tempDir, "empty.wasm"), new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]))
  await writeFile(entry, 'export const load = () => import("./empty.wasm?module")\n', "utf8")

  await bundleEsmEntry(entry, outfile, { format: "esm", platform: "neutral" })

  const [file] = (await readdir(join(tempDir, "out"))).filter(name => name.endsWith(".wasm"))
  expect(file).toMatch(/^empty-[\da-f]{8}\.wasm$/)
  expect(await readFile(outfile, "utf8")).toContain(`import("./${file}")`)
})

it("copies a plain Worker WebAssembly import and also loads the same file as raw text", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-internal-rolldown-wasm-"))
  const entry = join(tempDir, "entry.mjs")
  const outfile = join(tempDir, "out/bundle.mjs")
  const wasm = Buffer.from("\0asm\x01\0\0\0\0\x09\x08raw-test")
  await writeFile(join(tempDir, "empty.wasm"), wasm)
  await writeFile(entry, 'export { default } from "./empty.wasm"\nexport { default as raw } from "./empty.wasm?raw"\n', "utf8")

  await bundleEsmEntry(entry, outfile, { conditions: ["workerd", "worker", "browser", "default"], format: "esm", platform: "neutral" })

  const [file] = (await readdir(join(tempDir, "out"))).filter(name => name.endsWith(".wasm"))
  expect(file).toMatch(/^empty-[\da-f]{8}\.wasm$/)
  const code = await readFile(outfile, "utf8")
  expect(code).toMatch(new RegExp(`from\\s*"\\./${file}"`))
  expect(code).toContain("raw-test")
  expect(await readFile(join(tempDir, "out", file))).toEqual(wasm)
})

it("lets a caught missing WebAssembly import fall back at runtime", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-internal-rolldown-wasm-"))
  const entry = join(tempDir, "entry.mjs")
  const outfile = join(tempDir, "out/bundle.mjs")
  await writeFile(entry, 'export const load = () => import("./missing.wasm").catch(() => "fallback")\n', "utf8")

  await bundleEsmEntry(entry, outfile, { platform: "neutral" })

  const { load } = await import(pathToFileURL(outfile).href) as { load: () => Promise<unknown> }
  await expect(load()).resolves.toBe("fallback")
})

it("preserves caller resolutions that do not point to local WebAssembly files", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vitehub-internal-rolldown-wasm-"))
  const entry = join(tempDir, "entry.mjs")
  const outfile = join(tempDir, "out/bundle.mjs")
  const fallback = join(tempDir, "fallback.mjs")
  await writeFile(fallback, 'export default "js-fallback"\n', "utf8")
  await writeFile(entry, 'export { default as external } from "./external.wasm"\nexport { default as fallback } from "./alias.wasm"\n', "utf8")

  await bundleEsmEntry(entry, outfile, {
    platform: "neutral",
    plugins: [{
      name: "wasm-resolutions",
      resolveId(source) {
        if (source === "./external.wasm") return { id: source, external: true }
        if (source === "./alias.wasm") return fallback
      },
    }],
  })

  expect(await readdir(join(tempDir, "out"))).toEqual(["bundle.mjs"])
  const code = await readFile(outfile, "utf8")
  expect(code).toContain('from "./external.wasm"')
  expect(code).toContain('"js-fallback"')
})
