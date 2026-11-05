import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"

interface EncodedColocatedAgentFile {
  content: string
  encoding: "base64"
}

function isFolderAgentEntry(file: string): boolean {
  if (!/^(?:agent|index)\.(?:c|m)?[jt]s$/i.test(basename(file))) return false
  return !(basename(file).toLowerCase().startsWith("agent.")
    && basename(dirname(file)) === "agents"
    && basename(dirname(dirname(file))) === "server")
}

function colocatedAgentFilesRoot(handler: string, directoryName: string): string | undefined {
  if (!isFolderAgentEntry(handler)) return
  const root = join(dirname(handler), directoryName)
  return existsSync(root) ? root : undefined
}

export function resolveColocatedAgentFilesRoot(handler: string, directoryName: string): string | undefined {
  const root = colocatedAgentFilesRoot(handler, directoryName)
  return root && statSync(root).isDirectory() ? root : undefined
}

export function readColocatedAgentFiles(
  handler: string,
  directoryName: string,
): Record<string, EncodedColocatedAgentFile> | undefined {
  const root = colocatedAgentFilesRoot(handler, directoryName)
  if (!root) return
  const rootStats = statSync(root)
  if (!rootStats.isDirectory()) return

  const files: Record<string, EncodedColocatedAgentFile> = {}
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = join(directory, entry.name)
      const target = relative(root, file).replace(/\\/g, "/")
      if (entry.isDirectory()) {
        visit(file)
        continue
      }
      if (!entry.isFile()) continue

      const content = readFileSync(file)
      files[target] = {
        content: content.toString("base64"),
        encoding: "base64",
      }
    }
  }

  visit(root)
  return Object.keys(files).length ? files : undefined
}
