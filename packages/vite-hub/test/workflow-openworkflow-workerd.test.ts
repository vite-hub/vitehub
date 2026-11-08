import { fileURLToPath } from "node:url"

import { Miniflare } from "miniflare"
import { build } from "vite"
import { expect, it } from "vitest"

import type { Rollup } from "vite"

it("loads the OpenWorkflow runtime during a request in workerd", async () => {
  // `runAgent()` imports `@vite-hub/workflow` on its first Workflow dispatch, so this module first loads inside a request.
  // workerd allows code generation from strings only while the Worker starts.
  const entry = fileURLToPath(import.meta.resolve("@vite-hub/workflow/runtime/openworkflow"))
  const output = await build({
    build: { minify: false, rollupOptions: { output: { codeSplitting: false } }, ssr: entry, write: false },
    configFile: false,
    logLevel: "silent",
    ssr: { noExternal: true, target: "webworker" },
  }) as Rollup.RollupOutput
  const chunk = output.output.find((item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry)
  if (!chunk) throw new Error("Expected the bundled OpenWorkflow runtime.")

  const worker = new Miniflare({
    compatibilityDate: "2026-04-20",
    compatibilityFlags: ["nodejs_compat"],
    modules: [
      {
        contents: [
          "export default {",
          "  async fetch() {",
          "    try { return Response.json(Object.keys(await import(\"./openworkflow.mjs\")).sort()) }",
          "    catch (error) { return new Response(String(error), { status: 500 }) }",
          "  },",
          "}",
        ].join("\n"),
        path: "worker.mjs",
        type: "ESModule",
      },
      { contents: chunk.code, path: "openworkflow.mjs", type: "ESModule" },
    ],
  })
  try {
    const response = await worker.dispatchFetch("http://localhost/")
    const body = await response.text()
    expect(response.status, body).toBe(200)
    expect(JSON.parse(body)).toContain("runOpenWorkflow")
  }
  finally {
    await worker.dispose()
  }
}, 60_000)
