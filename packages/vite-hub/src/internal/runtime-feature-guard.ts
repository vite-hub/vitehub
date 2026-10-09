import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"]

function stripCommentsAndStrings(source: string): string {
  return source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, match =>
    match.startsWith("/") ? " ".repeat(match.length) : " ".repeat(match.length),
  )
}

function matchingBrace(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++
    if (source[index] === "}" && --depth === 0) return index
  }
  return -1
}

function hasAgentOptOut(source: string): boolean {
  const clean = stripCommentsAndStrings(source)
  const pluginNames = new Set<string>()
  for (const match of clean.matchAll(/\bimport\s*\{([\s\S]*?)\}\s*from\s*/gu)) {
    // `clean` keeps source positions while removing comments and strings. Check
    // the original source only at the module-specifier position so import-like
    // text in a comment or string cannot create a ViteHub binding.
    const fromOffset = match[0].lastIndexOf("from")
    const moduleStart = match.index! + fromOffset + "from".length
    if (!/^(?:(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*)["']vite-hub["']/u.test(source.slice(moduleStart))) continue
    for (const specifier of match[1].split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/u)
      if (parts[0] === "vitehub") pluginNames.add(parts[1] || parts[0])
    }
  }
  const starts: number[] = []
  for (const match of clean.matchAll(/\bvitehub\s*:\s*\{|\b([A-Za-z_$][\w$]*)\s*\(\s*\{/gu)) {
    const token = match[0]
    if (token.includes("(") && !pluginNames.has(match[1])) continue
    starts.push(match.index! + match[0].lastIndexOf("{"))
  }
  return starts.some(open => {
    const end = matchingBrace(clean, open)
    return end >= 0 && hasAgentOptOutInObject(clean.slice(open + 1, end))
  })
}

function hasAgentOptOutInObject(body: string): boolean {
  for (const match of body.matchAll(/\bagent\s*:\s*(false|\{)/gu)) {
    let depth = 0
    for (const character of body.slice(0, match.index)) {
      if (character === "{") depth++
      else if (character === "}") depth--
    }
    if (depth !== 0) continue
    if (match[1] === "false") return true
    const open = match.index! + match[0].lastIndexOf("{")
    const end = matchingBrace(body, open)
    if (end >= 0 && /\bcli\s*:\s*false\b/u.test(body.slice(open, end))) return true
  }
  return false
}

/** Detects explicit Agent CLI opt-outs without evaluating the project config. */
export async function isAgentCliEnabled(rootDir: string): Promise<boolean> {
  // Nuxt owns discovery whenever both config families exist, matching loadViteHubCliConfig.
  const owner = configExtensions.some(extension => existsSync(join(rootDir, `nuxt.config.${extension}`))) ? "nuxt" : "vite"
  for (const extension of configExtensions) {
    const path = join(rootDir, `${owner}.config.${extension}`)
    if (existsSync(path)) return !(hasAgentOptOut(await readFile(path, "utf8")))
  }
  return true
}
