import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

// A copy of the UI stylesheet went stale whenever `vite-hub` was built from another commit than `@vite-hub/ui`, so the
// facade imports the stylesheet of the installed package instead.
it("serves vite-hub/ui/styles.css as an import of @vite-hub/ui/styles.css", async () => {
  const facade = await readFile(fileURLToPath(import.meta.resolve("vite-hub/ui/styles.css")), "utf8")
  const rules = facade.replace(/\/\*[\s\S]*?\*\//g, "").trim()
  expect(rules).toBe("@import \"@vite-hub/ui/styles.css\";")
  expect(await readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8")).toBe(facade)
})
