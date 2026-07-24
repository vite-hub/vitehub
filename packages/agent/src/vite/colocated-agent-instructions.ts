import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { resolveInstructionImports } from "../instruction-composition.ts"

export async function readColocatedAgentInstructions(
  handler: string,
  options: { dependencies?: Set<string> } = {},
): Promise<string | undefined> {
  const file = join(dirname(handler), "instructions.md")
  options.dependencies?.add(file)
  if (!existsSync(file) || !statSync(file).isFile()) return
  return await resolveInstructionImports(readFileSync(file, "utf8"), {
    file,
    read(specifier, importer) {
      const imported = resolve(dirname(importer), specifier)
      options.dependencies?.add(imported)
      return {
        content: readFileSync(imported, "utf8"),
        file: imported,
      }
    },
  })
}
