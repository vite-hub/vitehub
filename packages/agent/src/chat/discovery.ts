import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"

import {
  discoverDefinitions,
  mergeDefinitions,
  normalizeSuffixDefinitionName,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredChatDefinition } from "./types.ts"

const chatSuffixPattern = /\.chat\.(?:c|m)?[jt]s$/i
const configPattern = /^config\.(?:c|m)?[jt]s$/i
const sourceFileExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

function normalizeSuffixChatName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, chatSuffixPattern, { stripPrefix: "src/" })
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function hasDefineAgentChat(source: string): boolean {
  const stripped = stripComments(source)
  return /\bdefineAgent\s*\(\s*\{[\s\S]*?\bchat\s*:/.test(stripped)
    || /\bdefineAgent\s*\(\s*\{[\s\S]*?\bcapabilities\s*:\s*\[[\s\S]*?\bchat\s*\(/.test(stripped)
}

function hasWorkspaceAgent(source: string): boolean {
  return /\bdefineAgent\s*\(\s*\{[\s\S]*?\bworkspace\s*:/.test(stripComments(source))
}

function discoverAgentChatDefinitions(scanDirs: string[]): DiscoveredChatDefinition[] {
  const definitions: DiscoveredChatDefinition[] = []

  for (const scanDir of scanDirs) {
    const agentsRoot = resolve(scanDir, "agents")
    const walk = (current: string) => {
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }

      for (const entry of entries) {
        const file = resolve(current, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
          walk(file)
          continue
        }

        if (!entry.isFile()) continue
        if (configPattern.test(basename(file))) {
          const source = readFileSync(file, "utf8")
          if (!hasDefineAgentChat(source)) continue
          const agentName = relative(agentsRoot, dirname(file)).replace(/\\/g, "/")
          if (agentName && agentName !== ".") {
            definitions.push({
              handler: file,
              name: agentName,
              source: "nitro-server-agent-chat",
              workspace: hasWorkspaceAgent(source) ? agentName : undefined,
            })
          }
          continue
        }

        if (!sourceFileExtensions.some(extension => file.endsWith(extension))) continue
        if (file.endsWith(".d.ts") || file.endsWith(".d.mts") || file.endsWith(".d.cts")) continue
        const source = readFileSync(file, "utf8")
        if (!hasDefineAgentChat(source)) continue
        const name = relative(agentsRoot, file).replace(/\.(?:c|m)?[jt]s$/i, "").replace(/\/index$/i, "").replace(/\\/g, "/")
        if (name && name !== ".") {
          definitions.push({ handler: file, name, source: "nitro-server-agent-chat" })
        }
      }
    }
    walk(agentsRoot)
  }

  return definitions
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

    return mergeDefinitions("chat", singleDefinitions, directoryDefinitions, discoverAgentChatDefinitions(options.scanDirs))
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
