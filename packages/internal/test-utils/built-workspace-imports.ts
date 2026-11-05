import { readFile } from "node:fs/promises"
import { resolveModuleURL } from "exsolve"

/** Follow static imports without tree shaking, including external Workspace package entries. */
export async function readBuiltWorkspaceImports(entry: URL): Promise<{ imports: string[], code: string }> {
  const seen = new Set<string>()
  const imports = new Set<string>()
  const sources: string[] = []

  async function visit(file: URL, workspace: boolean): Promise<void> {
    if (seen.has(file.href)) return
    seen.add(file.href)
    const code = await readFile(file, "utf8")
    if (workspace) sources.push(code)
    for (const match of code.matchAll(/^(?:import|export)\b[^"']*?from\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm)) {
      const specifier = match[1] ?? match[2] ?? ""
      if (specifier.startsWith(".")) await visit(new URL(specifier, file), workspace)
      else if (/^@vite-hub\/workspace(?:\/|$)/.test(specifier)) {
        imports.add(specifier)
        await visit(new URL(resolveModuleURL(specifier, { from: file })), true)
      }
    }
  }

  await visit(entry, false)
  return { imports: [...imports].sort(), code: sources.join("\n") }
}
