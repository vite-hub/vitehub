import { readdirSync, readFileSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizeSuffixDefinitionName,
} from "@vite-hub/internal/definition-catalog"

import type { DiscoveredAgentDefinition } from "./types.ts"

const agentSuffixPattern = /\.agent\.(?:c|m)?[jt]s$/i
const configPattern = /^config\.(?:c|m)?[jt]s$/i
const evalDefinitionPattern = /^(?:.+\.)?eval\.(?:c|m)?[jt]s$/i
const indexDefinitionPattern = /^index\.(?:c|m)?[jt]s$/i

function isEvalDefinitionFile(file: string): boolean {
  return evalDefinitionPattern.test(basename(file))
}

function normalizeSuffixAgentName(rootDir: string, file: string) {
  const name = normalizeSuffixDefinitionName(rootDir, file, agentSuffixPattern, { stripPrefix: "src/" })
  return name.startsWith("server/") ? undefined : name
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function isWorkspaceAgentConfig(source: string): boolean {
  return /\bdefineAgent\s*\(\s*\{[\s\S]*?\bworkspace\s*:/.test(stripComments(source))
}

function isInsideConfiguredAgent(file: string, configuredAgentDirs: Set<string>): boolean {
  const directory = dirname(file)
  for (const agentDir of configuredAgentDirs) {
    const path = relative(agentDir, directory)
    if (path === "" && indexDefinitionPattern.test(basename(file))) return false
    if (path === "" || (!path.startsWith("..") && path !== "..")) return true
  }
  return false
}

function isWorkspaceSourceConfig(file: string, configuredAgentDirs: Set<string>): boolean {
  const directory = dirname(file)
  for (const agentDir of configuredAgentDirs) {
    const path = relative(agentDir, directory).replace(/\\/g, "/")
    if (!path || path.startsWith("../") || path === "..") continue
    if (path.split("/")[0] === "workspace") return true
  }
  return false
}

function discoverDirectoryAgentConfigs(scanDirs: string[]): DiscoveredAgentDefinition[] {
  const candidates: DiscoveredAgentDefinition[] = []

  const walk = (agentsRoot: string, current: string) => {
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
        walk(agentsRoot, file)
        continue
      }

      if (!entry.isFile() || !configPattern.test(basename(file))) continue
      const source = readFileSync(file, "utf8")
      const agent = relative(agentsRoot, dirname(file)).replace(/\\/g, "/")
      if (!agent || agent === ".") continue
      const workspace = isWorkspaceAgentConfig(source)
      candidates.push({
        handler: file,
        name: agent,
        source: workspace ? "server-agent-workspace" : "server-agents",
        workspace: workspace ? agent : undefined,
      })
    }
  }

  for (const scanDir of scanDirs) {
    walk(resolve(scanDir, "agents"), resolve(scanDir, "agents"))
  }

  const configuredAgentDirs = new Set(candidates.map(definition => dirname(definition.handler)))
  return candidates.filter(definition => !isWorkspaceSourceConfig(definition.handler, configuredAgentDirs))
}

export function discoverAgentDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "server-agents", scanDirs: string[] }
): DiscoveredAgentDefinition[] {
  if (options.mode === "server-agents") {
    const configDefinitions = discoverDirectoryAgentConfigs(options.scanDirs)
    const configuredAgentDirs = new Set(configDefinitions.map(definition => dirname(definition.handler)))
    const directoryDefinitions = discoverDefinitions("agent", [
      createDirectoryDefinitionSource<DiscoveredAgentDefinition>("server-agents", options.scanDirs, "agents", {
        normalizeName(directory, file) {
          if (configPattern.test(basename(file)) || isEvalDefinitionFile(file)) return
          if (isInsideConfiguredAgent(file, configuredAgentDirs)) return
          return relative(directory, file).replace(/\.(?:c|m)?[jt]s$/i, "").replace(/\/index$/i, "")
        },
        createDefinition({ file, name }) {
          return {
            handler: file,
            name,
            source: "server-agents",
          }
        },
      }),
    ])

    return mergeDefinitions("agent", directoryDefinitions, configDefinitions)
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
