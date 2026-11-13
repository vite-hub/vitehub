import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { build } from "esbuild"
import type { Plugin } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { consoleOperationFeatures, transformConsoleOperationFeatures } from "../src/console/operation-features.ts"

it.each([
  ["src/console/runtime/server/rpc.ts", false, "vite"],
  ["dist/console/runtime/server/rpc.js", false, "vite"],
  ["src/console/runtime/server/rpc.ts", true, "vite"],
  ["dist/console/runtime/server/rpc.js", true, "vite"],
  ["src/console/runtime/server/rpc.ts", false, "nitro"],
  ["dist/console/runtime/server/rpc.js", false, "nitro"],
] as const)("bundles %s with enabled operations (rpcOnly: %s, host: %s)", async (entry, rpcOnly, host) => {
  for (const [enabled, workspace] of [[false, false], [false, true], [true, false], [true, true]] as const) {
    const plugin = host === "nitro"
      ? consoleOperationFeatures([...(enabled ? ["agents", "auth", "databases"] : []), ...(workspace ? ["workspaces"] : [])])
      : vitehub({ host: "node", agent: enabled, auth: enabled, database: enabled, workspace, ...rpcOnly ? {} : { comments: false, console: true } }).flat()
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
          // An app with Auth disabled must bundle even when its optional peer cannot be resolved.
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
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(dependency => dependency.path))
    for (const owner of ["@vite-hub/agent", "@vite-hub/auth", "drizzle-orm"]) {
      expect(imports.some(dependency => dependency === owner || dependency.startsWith(`${owner}/`)), `${entry}: ${owner}`).toBe(enabled)
    }
    // Invocation inspection also uses Workspace files when Agents are enabled.
    expect(imports.some(dependency => dependency.startsWith("@vite-hub/workspace/")), `${entry}: Workspace imports`).toBe(enabled || workspace)
    expect(Object.keys(result.metafile.inputs).some(path => /workspace-files\.get\.[jt]s$/.test(path)), `${entry}: Workspace browser`).toBe(workspace)
    // The Console journal loads libSQL when it opens, so the RPC handler never imports it.
    expect(imports, `${entry}: @libsql/client`).not.toContain("@libsql/client")
    expect(result.outputFiles[0]!.text).toContain('"agents.list"')
    expect(result.outputFiles[0]!.text).toContain('"databases.browse"')
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
    for (const module of entry.includes("definitions.get") ? ["documents"] : ["media", "documents"]) {
      const bundled = inputs.some(input => new RegExp(`/(?:runtime/server/)?${module}(?:-[\\w-]+)?\\.[jt]s$`).test(input))
      expect(bundled, `${entry}: ${module} (documents: ${documents})`).toBe(documents)
    }
  }
})
