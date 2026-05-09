import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizeSuffixDefinitionName,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredAgentDefinition } from "./types.ts"

const agentSuffixPattern = /\.agent\.(?:c|m)?[jt]s$/i
const sourceFileExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

function normalizeSuffixAgentName(rootDir: string, file: string) {
  const name = normalizeSuffixDefinitionName(rootDir, file, agentSuffixPattern, { stripPrefix: "src/" })
  return name.startsWith("server/") ? undefined : name
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function discoverNamedExports(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"))
  const names = new Set<string>()
  const patterns = [
    /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s*\{([^}]+)\}/g,
  ]

  for (const match of source.matchAll(patterns[0]!)) {
    names.add(match[1]!)
  }

  for (const match of source.matchAll(patterns[1]!)) {
    for (const entry of match[1]!.split(",")) {
      const [left, right] = entry.trim().split(/\s+as\s+/)
      const name = (right || left || "").trim()
      if (name && name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name)) {
        names.add(name)
      }
    }
  }

  return [...names].sort()
}

function discoverServerAgentsFiles(scanDirs: string[]): DiscoveredAgentDefinition[] {
  return scanDirs.flatMap((scanDir) => {
    const files = sourceFileExtensions
      .map(extension => resolve(scanDir, `agents${extension}`))
      .filter(file => existsSync(file))

    return files.flatMap(file => discoverNamedExports(file).map(exportName => ({
      exportName,
      handler: file,
      name: exportName,
      source: "nitro-server-agent" as const,
    })))
  })
}

export function discoverAgentDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-agents", scanDirs: string[] }
): DiscoveredAgentDefinition[] {
  if (options.mode === "nitro-server-agents") {
    const aggregateDefinitions = discoverServerAgentsFiles(options.scanDirs)
    const directoryDefinitions = discoverDefinitions("agent", [
      createDirectoryDefinitionSource<DiscoveredAgentDefinition>("nitro-server-agents", options.scanDirs, "agents", {
        createDefinition({ file, name }) {
          return {
            handler: file,
            name,
            source: "nitro-server-agents",
          }
        },
      }),
    ])

    return mergeDefinitions("agent", aggregateDefinitions, directoryDefinitions)
  }

  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return discoverDefinitions("agent", [{
    kind: "suffix",
    normalizeName: normalizeSuffixAgentName,
    pattern: agentSuffixPattern,
    roots: [...roots].map(root => resolve(root)),
    source: "vite-suffix",
  }])
}
