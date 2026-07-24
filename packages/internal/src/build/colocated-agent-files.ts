import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"

interface EncodedColocatedAgentFile {
  content: string
  encoding: "base64"
}

interface ColocatedAgentFileOptions {
  fileCountLimit?: number
  fileSizeLimit?: number
  label?: string
  rejectUnsupportedEntries?: boolean
  totalSizeLimit?: number
}

function formatSize(bytes: number): string {
  const mebibyte = 1024 * 1024
  return bytes % mebibyte === 0 ? `${bytes / mebibyte} MiB` : `${bytes} bytes`
}

function isFolderAgentEntry(file: string): boolean {
  if (!/^(?:agent|index)\.(?:c|m)?[jt]s$/i.test(basename(file))) return false
  return !(basename(file).toLowerCase().startsWith("agent.")
    && basename(dirname(file)) === "agents"
    && basename(dirname(dirname(file))) === "server")
}

export function readColocatedAgentFiles(
  handler: string,
  directoryName: string,
  options: ColocatedAgentFileOptions = {},
): Record<string, EncodedColocatedAgentFile> | undefined {
  if (!isFolderAgentEntry(handler)) return
  const root = join(dirname(handler), directoryName)
  if (!existsSync(root)) return
  const rootStats = options.rejectUnsupportedEntries ? lstatSync(root) : statSync(root)
  if (!rootStats.isDirectory()) {
    if (options.rejectUnsupportedEntries) {
      throw new Error(`[vitehub] ${options.label || "Colocated Agent files"} supports regular files and directories only: ${directoryName}`)
    }
    return
  }

  const files: Record<string, EncodedColocatedAgentFile> = {}
  let fileCount = 0
  let totalSize = 0
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = join(directory, entry.name)
      const target = relative(root, file).replace(/\\/g, "/")
      if (entry.isDirectory()) {
        visit(file)
        continue
      }
      if (!entry.isFile()) {
        if (options.rejectUnsupportedEntries) {
          throw new Error(`[vitehub] ${options.label || "Colocated Agent files"} supports regular files and directories only: ${target}`)
        }
        continue
      }

      const content = readFileSync(file)
      fileCount += 1
      if (options.fileCountLimit !== undefined && fileCount > options.fileCountLimit) {
        throw new Error(`[vitehub] ${options.label || "Colocated Agent files"} exceeds ${options.fileCountLimit} files.`)
      }
      if (options.fileSizeLimit !== undefined && content.byteLength > options.fileSizeLimit) {
        throw new Error(`[vitehub] ${options.label || "Colocated Agent file"} file exceeds ${formatSize(options.fileSizeLimit)}: ${target}`)
      }
      totalSize += content.byteLength
      if (options.totalSizeLimit !== undefined && totalSize > options.totalSizeLimit) {
        throw new Error(`[vitehub] ${options.label || "Colocated Agent files"} exceeds ${formatSize(options.totalSizeLimit)}.`)
      }
      files[target] = {
        content: content.toString("base64"),
        encoding: "base64",
      }
    }
  }

  visit(root)
  return Object.keys(files).length ? files : undefined
}
