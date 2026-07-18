import { readFile, readdir } from "node:fs/promises"

import { expect, it } from "vitest"

it("keeps Effect out of published Agent declarations", async () => {
  const dist = new URL("../dist/", import.meta.url)
  const declarations = await Promise.all(
    (await readdir(dist, { recursive: true }))
      .filter(path => path.endsWith(".d.ts"))
      .map(path => readFile(new URL(path, dist), "utf8")),
  )

  expect(declarations.join("\n")).not.toMatch(/(?:from\s*|import\()\s*["']effect["']/)
})
