import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { isPlainObject } from "@vite-hub/internal/object"

import { collapseWranglerD1Bindings } from "./cloudflare.ts"

/**
 * Nitro's Cloudflare preset merges the project's wrangler config into the generated one with defu, which concatenates
 * arrays, so a D1 binding that both declare appears twice. Run this in a `compiled` hook, after the preset wrote the file.
 */
export async function collapseGeneratedWranglerD1Bindings(serverDir: string): Promise<void> {
  const file = resolve(serverDir, "wrangler.json")
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return
  const wrangler: unknown = JSON.parse(text)
  if (!isPlainObject(wrangler)) return
  const collapsed = collapseWranglerD1Bindings(wrangler)
  if (collapsed) await writeFile(file, `${JSON.stringify(collapsed, null, 2)}\n`)
}
