import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export async function readPnpmCatalogVersion(cwd: string, name: string, catalog: string): Promise<string | undefined> {
  let directory = cwd
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    if (dirname(directory) === directory) return
    directory = dirname(directory)
  }
  const code = await readFile(join(directory, "pnpm-workspace.yaml"), "utf8")
  let section: string | undefined
  let current: string | undefined
  let catalogIndent: number | undefined
  for (const line of code.split(/\r?\n/)) {
    const entry = /^( *)(["']?)([^"'#:]+?)\2[ \t]*:(?:[ \t]+(.*))?$/.exec(line)
    if (!entry) continue
    const [, indent = "", , key = ""] = entry
    const value = entry[4]?.replace(/(?:^|[ \t]+)#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2")
    if (!indent) {
      section = key
      current = section === "catalog" ? "default" : undefined
      catalogIndent = undefined
      continue
    }
    if (section === "catalogs" && (catalogIndent === undefined || indent.length <= catalogIndent)) {
      catalogIndent = indent.length
      current = key
      continue
    }
    if (current === catalog && key === name && value) return value
  }
}
