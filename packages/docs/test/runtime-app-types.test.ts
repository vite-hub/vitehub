import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { expect, it } from "vitest"

// Nuxt compiles `runtime/app` from source, and a site's typecheck reads it with the site's `.nuxt/tsconfig.app.json`.
// Nuxt 5 sites check with TypeScript 7.
const docsTheme = resolve(import.meta.dirname, "../runtime/app/utils/docs-theme.ts")
const typescript7 = resolve(import.meta.dirname, "../../../node_modules/typescript-native/bin/tsc")

/** The output of TypeScript 7 for the docs theme, with the options of a Nuxt 5 app tsconfig that decide how imports resolve. */
async function typecheck(paths: Record<string, string[]> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docs-runtime-types-"))
  try {
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        esModuleInterop: true,
        module: "preserve",
        moduleResolution: "bundler",
        noEmit: true,
        paths,
        skipLibCheck: true,
        strict: true,
        target: "esnext",
        types: [],
        verbatimModuleSyntax: true,
      },
      files: [docsTheme],
    }))
    const result = spawnSync(process.execPath, [typescript7, "-p", root], { encoding: "utf8" })
    return `${result.stdout}${result.stderr}`.trim()
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

it("typechecks the docs theme in a Nuxt app, where `typescript.hoist` maps defu to its package folder", async () => {
  // A path to the folder makes TypeScript read the `types` field of defu, a declaration with `export =`.
  await expect(typecheck({ defu: [resolve(import.meta.dirname, "../node_modules/defu")] })).resolves.toBe("")
})

it("typechecks the docs theme with the package exports of defu", async () => {
  await expect(typecheck()).resolves.toBe("")
})
