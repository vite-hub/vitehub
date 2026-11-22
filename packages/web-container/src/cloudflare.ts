import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { matchesWebContainerRoute, normalizeWebContainerPath, webContainerHeaders } from "./routes.ts"

interface NitroLike {
  hooks: { hook(name: "compiled", callback: () => Promise<void>): unknown }
  options: { baseURL: string, dev: boolean, output: { dir: string, publicDir: string }, preset?: string }
}

const isolationLines = Object.entries(webContainerHeaders).map(([name, value]) => `  ${name}: ${value}`)
const isolationNames = new Set(Object.keys(webContainerHeaders).map(name => name.toLowerCase()))

/** Cloudflare combines matching blocks, so write isolation once per path while keeping other Nitro headers. */
export function cloudflareWebContainerHeaders(routes: readonly string[], nitroPatterns: string[]): (nitro: NitroLike) => void {
  const patterns = [...new Set(routes.map(normalizeWebContainerPath))]
  const staticPatterns = patterns.flatMap((pattern) => {
    const others = patterns.filter(other => other !== pattern && other.endsWith("/**"))
    if (matchesWebContainerRoute(pattern, others)) return []
    if (pattern === "/**") return ["/*"]
    if (pattern.endsWith("/**")) return [pattern.slice(0, -3), pattern.slice(0, -1)]
    return pattern === "/" ? [pattern] : [pattern, `${pattern}/`]
  })

  return (nitro) => {
    const { baseURL, dev, output, preset } = nitro.options
    if (dev || !/^cloudflare(?:[-_]|$)/.test(preset ?? "")) return
    nitro.hooks.hook("compiled", async () => {
      const base = baseURL.replace(/\/+$/, "")
      const publicDir = output.publicDir.replace(/\/+$/, "")
      const directory = /^cloudflare[-_]pages/.test(preset!) ? output.dir : base && publicDir.endsWith(base) ? publicDir.slice(0, -base.length) : publicDir
      const file = join(directory, "_headers")
      const contents = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      const pending = new Set(staticPatterns.map(path => base + path))
      const managed = new Set([...pending, ...nitroPatterns.map(path => base + path.replace(/\/\*\*$/, "/*"))])
      const blocks = contents.split(/\r?\n(?=\S)/).flatMap((block) => {
        const [path = "", ...lines] = block.trimEnd().split(/\r?\n/)
        if (!managed.has(path)) return block.trimEnd() ? [block.trimEnd()] : []
        const kept = lines.filter(line => !isolationNames.has(line.trim().replace(/^!\s*/, "").split(":", 1)[0]!.trim().toLowerCase()))
        if (pending.delete(path)) kept.push(...isolationLines)
        return kept.some(line => line.trim()) ? [[path, ...kept].join("\n")] : []
      })
      for (const path of pending) blocks.push([path, ...isolationLines].join("\n"))
      await writeFile(file, `${blocks.join("\n")}\n`, "utf8")
    })
  }
}
