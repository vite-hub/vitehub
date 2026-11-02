import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

const dist = fileURLToPath(new URL("../dist/", import.meta.url))

// The package test script builds dist first. A literal import makes Vite resolve the optional package while it
// analyzes the module, so Vite SSR fails with VITE_HUB_R0075 when Blob is off, even though nothing calls the loader.
it("keeps the optional Blob and Database imports out of Vite import analysis in the built package", async () => {
  const chunks = await Promise.all((await readdir(dist)).filter(file => file.endsWith(".js")).map(file => readFile(`${dist}${file}`, "utf8")))
  const loaders = chunks.filter(chunk => chunk.includes("function loadAgentWorkflowBlobPrimitive"))
  expect(loaders).toHaveLength(1)
  expect(loaders[0]).not.toMatch(/import\(\s*(?:\/\*[^*]*\*\/\s*)?["']@vite-hub\/(?:blob|database\/drizzle)["']/)
})
