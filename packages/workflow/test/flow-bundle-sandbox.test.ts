import { builtinModules } from "node:module"
import { fileURLToPath } from "node:url"

import { assertFlowBundleIsSandboxSafe } from "@workflow/builders"
import { build } from "esbuild"
import { expect, it } from "vitest"

import type { Plugin } from "esbuild"

const builtins = new Set(builtinModules)

// Workflow DevKit leaves Node built-ins external in the flow bundle, and the flow sandbox has no `require`.
const externalNodeBuiltins: Plugin = {
  name: "external-node-builtins",
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => args.path.startsWith("node:") || builtins.has(args.path) ? { path: args.path, external: true } : undefined)
  },
}

it("keeps defineWorkflow loadable in the Vercel Workflow sandbox", async () => {
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url))
  // Same options as the flow bundle of `@workflow/builders`.
  const result = await build({
    stdin: {
      contents: `import { defineWorkflow } from ${JSON.stringify(entry)}\nexport default defineWorkflow("roundtrip", async () => "ok")\n`,
      loader: "js",
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    conditions: ["workflow"],
    format: "cjs",
    mainFields: ["module", "main"],
    metafile: true,
    platform: "neutral",
    plugins: [externalNodeBuiltins],
    target: "es2022",
    treeShaking: true,
    write: false,
  })
  const bundleText = result.outputFiles[0]!.text

  expect([...bundleText.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])).toEqual([])
  await expect(assertFlowBundleIsSandboxSafe({ bundleText, metafile: result.metafile })).resolves.toBeDefined()
})
