import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { build } from "esbuild"
import type { Plugin } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "../src/index.ts"

it.each([
  ["src/console/runtime/server/rpc.ts", false],
  ["dist/console/runtime/server/rpc.js", false],
  ["src/console/runtime/server/rpc.ts", true],
  ["dist/console/runtime/server/rpc.js", true],
] as const)("bundles %s with enabled operations (rpcOnly: %s)", async (entry, rpcOnly) => {
  for (const enabled of [false, true]) {
    const plugin = vitehub({ preset: "node", agent: enabled, database: enabled, ...rpcOnly ? {} : { console: { auth: false } } }).flat()
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
          builder.onLoad({ filter: /\.[jt]s$/ }, async ({ path }) => {
            const code = await readFile(path, "utf8")
            // SAFETY: The operation transform reads only its source argument.
            const transformed = await transform.call({} as never, code, path, { ssr: true })
            const contents = typeof transformed === "string" ? transformed : transformed?.code
            return contents === undefined ? undefined : { contents, loader: path.endsWith(".ts") ? "ts" : "js" }
          })
        },
      }],
    })
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(dependency => dependency.path))
    for (const owner of ["@vite-hub/agent", "@libsql/client", "drizzle-orm"]) {
      expect(imports.some(dependency => dependency === owner || dependency.startsWith(`${owner}/`)), `${entry}: ${owner}`).toBe(enabled)
    }
    expect(result.outputFiles[0]!.text).toContain('"agents.list"')
    expect(result.outputFiles[0]!.text).toContain('"databases.browse"')
  }
})
