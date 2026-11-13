import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import ts from "typescript"
import { describe, expect, it } from "vitest"

import { hubBlob } from "../src/vite.ts"

async function writeStoreTypes(root: string, importBase: string) {
  const plugin = hubBlob({ stores: { default: { driver: "fs" }, media: { driver: "fs" } } }, { importBase })
  await (plugin.configResolved as (config: unknown) => Promise<void>)({ build: { outDir: "dist" }, root } as never)
  return join(root, ".vitehub/types/blob.d.ts")
}

describe("generated Blob store types", () => {
  it.each(["@vite-hub/blob", "vite-hub/blob"])("rejects an unknown store name through %s", async (importBase) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-store-types-"))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "blob-store-types", type: "module" }))
      await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
      await symlink(resolve(import.meta.dirname, ".."), join(root, "node_modules/@vite-hub/blob"), "dir")
      const declaration = await writeStoreTypes(root, importBase)
      expect(await readFile(declaration, "utf8")).toBe([
        "export {}",
        "",
        `declare module ${JSON.stringify(importBase)} {`,
        "  interface BlobStoreRegistry {",
        "    \"default\": true",
        "    \"media\": true",
        "  }",
        "}",
        "",
      ].join("\n"))
      const entry = join(root, "index.mts")
      await writeFile(entry, [
        "import { blob, file, type BlobStoreName } from \"@vite-hub/blob\"",
        "import { blob as publicBlob } from \"vite-hub/blob\"",
        "blob.store(\"media\")",
        "publicBlob.store(\"default\", { mode: \"read\" })",
        "file({ store: \"media\" })",
        "// @ts-expect-error The app configures no `medai` store.",
        "blob.store(\"medai\")",
        "// @ts-expect-error The app configures no `medai` store.",
        "publicBlob.store(\"medai\", { mode: \"read\" })",
        "// @ts-expect-error The app configures no `medai` store.",
        "file({ store: \"medai\" })",
        "declare const name: string",
        "// @ts-expect-error A `string` can hold a name that the app does not configure.",
        "blob.store(name)",
        "blob.store(name as BlobStoreName)",
      ].join("\n"))
      const program = ts.createProgram([entry, declaration], {
        module: ts.ModuleKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ESNext,
        // Use the distribution's real barrel without building it.
        paths: { "vite-hub/blob": [resolve(import.meta.dirname, "../../vite-hub/src/blob.ts")] },
      })
      expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares no store names when Blob is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-store-types-off-"))
    try {
      const plugin = hubBlob(false)
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ build: { outDir: "dist" }, root } as never)
      expect(await readFile(join(root, ".vitehub/types/blob.d.ts"), "utf8")).toBe("export {}\n")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
