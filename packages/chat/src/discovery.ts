import { existsSync } from "node:fs"
import { resolve } from "node:path"

import {
  discoverDefinitions,
  mergeDefinitions,
  normalizeSuffixDefinitionName,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredChatDefinition } from "./types.ts"

const chatSuffixPattern = /\.chat\.(?:c|m)?[jt]s$/i
const sourceFileExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

function normalizeSuffixChatName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, chatSuffixPattern, { stripPrefix: "src/" })
}

export function discoverChatDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-chats", scanDirs: string[] }
): DiscoveredChatDefinition[] {
  if (options.mode === "nitro-server-chats") {
    const singleDefinitions = options.scanDirs.flatMap((scanDir) => {
      const serverChatFiles = sourceFileExtensions
        .map(extension => resolve(scanDir, `chat${extension}`))
        .filter(file => existsSync(file))

      return serverChatFiles.map(file => ({
        handler: file,
        name: "chat",
        source: "nitro-server-chat",
      }))
    })

    const directoryDefinitions = discoverDefinitions("chat", [{
      kind: "directory",
      scanDirs: options.scanDirs,
      source: "nitro-server-chats",
      subdir: "chats",
    }])

    return mergeDefinitions("chat", singleDefinitions, directoryDefinitions)
  }

  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return discoverDefinitions("chat", [{
    kind: "suffix",
    normalizeName: normalizeSuffixChatName,
    pattern: chatSuffixPattern,
    roots: [...roots].map(root => resolve(root)),
    source: "vite-suffix",
  }])
}
