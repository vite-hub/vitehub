import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { expect, it } from "vitest"

it("owns the H3 runtime used by generated Cloudflare workers", async () => {
  const dist = new URL("../dist", import.meta.url)
  const files = (await readdir(dist, { recursive: true }))
    .filter(file => file.endsWith(".js"))
  const output = (await Promise.all(files.map(file => readFile(join(dist.pathname, file), "utf8")))).join("\n")

  expect(output).not.toContain('from "h3/cloudflare"')
})
