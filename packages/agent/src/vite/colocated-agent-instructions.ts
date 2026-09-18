import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

export async function readColocatedAgentInstructions(
  handler: string,
  options: { dependencies?: Set<string> } = {},
): Promise<string | undefined> {
  const file = join(dirname(handler), "instructions.md")
  options.dependencies?.add(file)
  if (!existsSync(file) || !statSync(file).isFile()) return
  return readFileSync(file, "utf8")
}
