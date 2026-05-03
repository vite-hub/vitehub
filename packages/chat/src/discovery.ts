import { resolve } from "node:path"

import {
  discoverDefinitions,
  normalizeSuffixDefinitionName,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredChatDefinition } from "./types.ts"

const chatSuffixPattern = /\.chat\.(?:c|m)?[jt]s$/i

function normalizeSuffixChatName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, chatSuffixPattern, { stripPrefix: "src/" })
}

export function discoverChatDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-chats", scanDirs: string[] }
): DiscoveredChatDefinition[] {
  if (options.mode === "nitro-server-chats") {
    return discoverDefinitions("chat", [{
      kind: "directory",
      scanDirs: options.scanDirs,
      source: "nitro-server-chats",
      subdir: "chats",
    }])
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
