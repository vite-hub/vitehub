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

// Nuxt 5 applies its Nitro v2 compatibility layer to server code that imports `h3` and warns NUXT_B9003. `nitro/h3`
// is the same H3 for Nitro 3.
it("imports H3 through nitro/h3", async () => {
  const dist = new URL("../dist", import.meta.url)
  const files = (await readdir(dist, { recursive: true })).filter(file => file.endsWith(".js"))
  const imports = await Promise.all(files.map(async file => [file, (await readFile(join(dist.pathname, file), "utf8")).match(/^import\s[^;]*?from\s*["']h3["']/gm)] as const))
  expect(imports.filter(([, found]) => found).map(([file]) => file)).toEqual([])
})
