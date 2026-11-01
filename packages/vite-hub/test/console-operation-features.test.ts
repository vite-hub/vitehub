import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { build } from "esbuild"
import { expect, it } from "vitest"

import { transformConsoleOperationFeatures } from "../src/console/operation-features.ts"

it.each(["src/console/runtime/server/rpc.ts", "dist/console/runtime/server/rpc.js"])("bundles %s without disabled Agent and Database dependencies", async (entry) => {
  for (const enabled of [false, true]) {
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
            const contents = transformConsoleOperationFeatures(code, enabled ? ["agents", "databases"] : [])
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
