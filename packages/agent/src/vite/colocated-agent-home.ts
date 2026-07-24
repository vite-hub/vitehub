import { readColocatedAgentFiles } from "@vite-hub/internal/build/colocated-agent-files"

export interface EncodedColocatedAgentHomeFile {
  contents: string
  encoding: "base64"
}

const fileSizeLimit = 1024 * 1024
const totalSizeLimit = 4 * 1024 * 1024

export function readColocatedAgentHome(handler: string): Record<string, EncodedColocatedAgentHomeFile> | undefined {
  const files = readColocatedAgentFiles(handler, "home", {
    fileCountLimit: 1024,
    fileSizeLimit,
    label: "Colocated Agent Home",
    rejectUnsupportedEntries: true,
    totalSizeLimit,
  })
  if (!files) return
  return Object.fromEntries(Object.entries(files).map(([target, file]) => [
    target,
    { contents: file.content, encoding: file.encoding },
  ]))
}
