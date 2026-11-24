import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { build } from "esbuild"
import type { Plugin } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { consoleDocumentEditorSectionIds } from "../src/console/contributions.ts"
import { consoleOperationFeatures, transformConsoleOperationFeatures } from "../src/console/operation-features.ts"
import { consoleOperationModules } from "../src/console/operation-modules.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

const primitiveOperations = /\/(?:agent|auth|blob|content|database|env|logs|workspace)\/console\/operations\.[jt]s$/

it.each([
  ["src/console/runtime/server/rpc.ts", false, "vite"],
  ["dist/console/runtime/server/rpc.js", false, "vite"],
  ["src/console/runtime/server/rpc.ts", true, "vite"],
  ["dist/console/runtime/server/rpc.js", true, "vite"],
  ["src/console/runtime/server/rpc.ts", false, "nitro"],
  ["dist/console/runtime/server/rpc.js", false, "nitro"],
] as const)("bundles %s without the operations of a primitive (rpcOnly: %s, host: %s)", async (entry, rpcOnly, host) => {
  for (const enabled of [false, true]) {
    const plugin = host === "nitro"
      ? consoleOperationFeatures(enabled ? ["agents", "auth", "databases", "workspaces"] : [])
      : vitehub({ host: "node", agent: enabled, auth: enabled, database: enabled, workspace: enabled, ...rpcOnly ? {} : { comments: false, console: true } }).flat()
          .find((option): option is Plugin => option !== null && typeof option === "object" && "name" in option && option.name === "vite-hub/console")
    const transform = typeof plugin?.transform === "function" ? plugin.transform : plugin?.transform?.handler
    if (!transform) throw new Error("Expected the Console operation transform.")
    const result = await build({
      absWorkingDir: resolve(import.meta.dirname, ".."),
      bundle: true,
      entryPoints: [entry],
      format: "esm",
      metafile: true,
      packages: "external",
      platform: "node",
      write: false,
      plugins: [{
        name: "console-operation-features",
        setup(builder) {
          if (!enabled) builder.onResolve({ filter: /^@vite-hub\/auth(?:\/|$)/ }, () => ({ errors: [{ text: "Auth is not installed." }] }))
          builder.onLoad({ filter: /\.[jt]s$/ }, async ({ path }) => {
            const code = await readFile(path, "utf8")
            const loader = path.endsWith(".ts") ? "ts" : "js"
            // SAFETY: The operation transform reads only its source argument.
            const transformed = await transform.call({} as never, code, path, { ssr: true, moduleType: loader })
            const contents = typeof transformed === "string" ? transformed : transformed?.code?.toString()
            return contents === undefined ? undefined : { contents, loader }
          })
        },
      }],
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.filter(path => primitiveOperations.test(path)), `${entry} (enabled: ${enabled})`).toEqual([])
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(dependency => dependency.path))
    expect(imports, `${entry}: @libsql/client`).not.toContain("@libsql/client")
    expect(result.outputFiles[0]!.text).not.toContain('"agents.list"')
    expect(result.outputFiles[0]!.text).not.toContain('"databases.browse"')
  }
})

it.each([
  "src/console/runtime/server/blob.ts",
  "src/console/runtime/server/rpc.ts",
  "src/console/runtime/server/definitions.get.ts",
  "dist/console/runtime/server/blob.js",
  "dist/console/runtime/server/rpc.js",
  "dist/console/runtime/server/definitions.get.js",
])("bundles the document editor and media code of %s only when an owner contributes a document editor", async (entry) => {
  for (const documents of [false, true]) {
    const result = await build({
      absWorkingDir: resolve(import.meta.dirname, ".."),
      bundle: true,
      entryPoints: [entry],
      format: "esm",
      metafile: true,
      packages: "external",
      platform: "node",
      write: false,
      plugins: [{
        name: "console-operation-features",
        setup(builder) {
          builder.onLoad({ filter: /\.[jt]s$/ }, async ({ path }) => {
            const code = await readFile(path, "utf8")
            return { contents: transformConsoleOperationFeatures(code, [], documents) ?? code, loader: path.endsWith(".ts") ? "ts" : "js" }
          })
        },
      }],
    })
    const inputs = Object.keys(result.metafile.inputs)
    // The dist build names shared chunks after one of their modules, such as `media-<hash>.js`.
    for (const module of entry.includes("blob") ? ["media", "documents"] : ["documents"]) {
      const bundled = inputs.some(input => new RegExp(`/(?:runtime/server/|blob/console/)?${module}(?:-[\\w-]+)?\\.[jt]s$`).test(input))
      expect(bundled, `${entry}: ${module} (documents: ${documents})`).toBe(documents)
    }
    if (entry.includes("rpc")) expect(inputs.filter(input => /(?:^|\/)media(?:-[\w-]+)?\.[jt]s$/.test(input)), `${entry}: media`).toEqual([])
  }
})

it("keeps the media library only when the app configures a document editor section", () => {
  const editor = consoleDocumentEditorSectionIds[0]
  if (!editor) throw new Error("Expected an installed document editor section.")
  expect(transformConsoleOperationFeatures("import.meta.viteHubConsoleDocuments", ["agents"])).toBe("false")
  expect(transformConsoleOperationFeatures("import.meta.viteHubConsoleDocuments", ["agents", editor])).toBe("true")
  expect(transformConsoleOperationFeatures("import.meta.viteHubConsoleDocuments", ["agents"], true)).toBe("true")
})

it("reads the document editors of the written app module on Nuxt", () => {
  const transform = consoleOperationFeatures([], () => true).transform
  const handler = typeof transform === "function" ? transform : transform?.handler
  // SAFETY: The operation transform reads only its source argument.
  expect(handler?.call({} as never, "import.meta.viteHubConsoleDocuments", "operations.ts")).toMatchObject({ code: "true" })
})

it("turns on the document editor code when discovery finds server/content.ts", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-documents-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n")
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "server/content.ts"), `import { defineContent } from "vite-hub/content"\nimport { documents } from "vite-hub/content/collections"\nexport default defineContent({ workspace: "site", collections: { posts: documents({ path: "posts/*.md", fields: {} }) } })\n`)
    const plugin = consoleVitePlugin({ console: {}, sections: [] })
    const configHook = plugin.config
    const configHandler = typeof configHook === "function" ? configHook : configHook?.handler
    const transformHook = plugin.transform
    const transform = typeof transformHook === "function" ? transformHook : transformHook?.handler
    if (!configHandler || !transform) throw new Error("Expected the Console config and transform hooks.")
    await Reflect.apply(configHandler, {}, [{ root }, { command: "build", mode: "production" }])
    const app = await readFile(join(root, ".vitehub/nitro/console/app.mjs"), "utf8")
    expect(app).toContain("documentConsoleOperations")
    // SAFETY: The operation transform reads only its source argument.
    expect(await transform.call({} as never, "import.meta.viteHubConsoleDocuments", "operations.ts")).toMatchObject({ code: "true" })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

it("registers the media library only with a document editor and Blob", () => {
  const media = consoleOperationModules.find(entry => entry.export === "mediaConsoleOperations")
  expect(media?.enabled({ documents: true, sections: [], site: false })).toBe(false)
  expect(media?.enabled({ documents: false, sections: ["blob"], site: false })).toBe(false)
  expect(media?.enabled({ documents: true, sections: ["blob"], site: false })).toBe(true)
})
