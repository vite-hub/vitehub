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
  return /\bdefineAgent\s*\(\s*\{[\s\S]*?\bchat\s*:/.test(stripComments(source))
}

function parseAgentName(source: string): string | undefined {
  const match = stripComments(source).match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/)
  return match?.[1]
}

function hasWorkspaceAgent(source: string): boolean {
  return /\bdefineAgent\s*\(\s*\{[\s\S]*?\bworkspace\s*:/.test(stripComments(source))
}

function discoverNamedAgentChatExports(file: string): DiscoveredChatDefinition[] {
  const source = readFileSync(file, "utf8")
  if (!hasDefineAgentChat(source)) return []

  const names = new Set<string>()
  for (const match of stripComments(source).matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*defineAgent\s*\(\s*\{[\s\S]*?\bchat\s*:/g)) {
    names.add(match[1]!)
  }

  const definitions: DiscoveredChatDefinition[] = [...names].sort().map(name => ({
    exportName: name,
    handler: file,
    name,
    source: "nitro-server-agent-chat",
  }))
  if (/\bexport\s+default\s+defineAgent\s*\(\s*\{[\s\S]*?\bchat\s*:/.test(stripComments(source))) {
    definitions.unshift({
      handler: file,
      name: "chat",
      source: "nitro-server-agent-chat",
    })
  }
  return definitions
}

function discoverAgentChatDefinitions(scanDirs: string[]): DiscoveredChatDefinition[] {
  const definitions: DiscoveredChatDefinition[] = []

  for (const scanDir of scanDirs) {
    for (const extension of sourceFileExtensions) {
      const file = resolve(scanDir, `agent${extension}`)
      if (existsSync(file)) definitions.push(...discoverNamedAgentChatExports(file))
    }

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
          const name = parseAgentName(source) || agentName
          if (name && name !== ".") {
            definitions.push({
              handler: file,
              name,
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
        const name = parseAgentName(source) || relative(agentsRoot, file).replace(/\.(?:c|m)?[jt]s$/i, "").replace(/\/index$/i, "").replace(/\\/g, "/")
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
