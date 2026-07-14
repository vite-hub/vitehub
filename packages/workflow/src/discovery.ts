import { readFileSync, readdirSync, statSync } from "node:fs"
import { relative } from "node:path"

import { normalize, resolve } from "pathe"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  registerDefinition,
  resolveDefinitionScanRoots,
  sortDefinitions,
} from "@vite-hub/internal/definition-catalog"

import type { DiscoveredWorkflowDefinition } from "./types.ts"

const workflowSuffixPattern = /\.workflow\.(?:c|m)?[jt]s$/i
const agentSuffixPattern = /\.agent\.(?:c|m)?[jt]s$/i
const sourceFilePattern = /\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
const stepFilePattern = /^\d+[.-].*\.(?:c|m)?[jt]s$/i
const folderAgentFilePattern = /^agent\.(?:c|m)?[jt]s$/i
const legacyFolderAgentFilePattern = /^config\.(?:c|m)?[jt]s$/i
const agentEvalFilePattern = /\.eval\.(?:c|m)?[jt]s$/i

function normalizeSuffixWorkflowName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, workflowSuffixPattern, { stripPrefix: "src/" })
}

function normalizeSuffixAgentName(rootDir: string, file: string) {
  const name = normalizeSuffixDefinitionName(rootDir, file, agentSuffixPattern, { stripPrefix: "src/" })
  return name.startsWith("server/") ? undefined : name
}

function readDirEntries(root: string) {
  try {
    return readdirSync(root, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw error
  }
}

function isSourceFile(file: string) {
  return sourceFilePattern.test(file) && !declarationFilePattern.test(file)
}

function stripSourceComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function extractAgentWorkflowName(file: string, fallbackName: string): string | undefined {
  const source = stripSourceComments(readFileSync(file, "utf8"))
  const match = /\bruntime\s*:\s*workflow\s*\(([^)]*)\)/m.exec(source)
  if (match) {
    const literal = /^\s*(["'`])([^"'`]+)\1\s*$/.exec(match[1] || "")
    return literal?.[2] || fallbackName
  }
  return /\bruntime\s*:\s*false\b/m.test(source) ? undefined : fallbackName
}

function toAgentWorkflowDefinition(file: string, fallbackName: string): DiscoveredWorkflowDefinition | undefined {
  const name = extractAgentWorkflowName(file, fallbackName)
  return name ? { handler: file, name, source: "agent-workflow" } : undefined
}

function isWorkflowFolder(directory: string) {
  return readDirEntries(directory).some(entry => entry.isFile() && (entry.name.toLowerCase().startsWith("index.") || stepFilePattern.test(entry.name)) && isSourceFile(entry.name))
}

function findWorkflowFolders(workflowsDir: string): string[] {
  const folders: string[] = []
  for (const entry of readDirEntries(workflowsDir)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) {
      continue
    }

    const directory = resolve(workflowsDir, entry.name)
    if (isWorkflowFolder(directory)) {
      folders.push(directory)
      continue
    }

    folders.push(...findWorkflowFolders(directory))
  }

  return folders.sort()
}

function hasFolderAgentDefinition(directory: string): boolean {
  return readDirEntries(directory).some(entry => entry.isFile() && folderAgentFilePattern.test(entry.name) && isSourceFile(entry.name))
}

function findFolderAgentFiles(agentsDir: string): string[] {
  const files: string[] = []
  for (const entry of readDirEntries(agentsDir)) {
    if (entry.name.startsWith(".")) {
      continue
    }
    const absolute = resolve(agentsDir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      files.push(...findFolderAgentFiles(absolute))
      continue
    }
    if (entry.isFile() && folderAgentFilePattern.test(entry.name) && isSourceFile(entry.name)) {
      files.push(absolute)
    }
  }
  return files.sort()
}

function discoverSuffixAgentWorkflowDefinitions(roots: string[]): DiscoveredWorkflowDefinition[] {
  return discoverDefinitions("agent workflow", [
    createSuffixDefinitionSource<DiscoveredWorkflowDefinition>("agent-workflow", roots, agentSuffixPattern, normalizeSuffixAgentName, {
      createDefinition: ({ file, name }) => ({ handler: file, name, source: "agent-workflow" }),
    }),
  ]).flatMap((definition) => {
    const workflowDefinition = toAgentWorkflowDefinition(definition.handler, definition.name)
    return workflowDefinition ? [workflowDefinition] : []
  })
}

function discoverFlatServerAgentWorkflowDefinitions(scanDirs: string[]): DiscoveredWorkflowDefinition[] {
  return discoverDefinitions("agent workflow", [
    createDirectoryDefinitionSource<DiscoveredWorkflowDefinition>("agent-workflow", scanDirs, "agents", {
      normalizeName(directory, file) {
        const fileName = normalize(file).split("/").pop()!
        const parent = normalize(resolve(file, ".."))
        if ((folderAgentFilePattern.test(fileName) && parent !== normalize(directory))
          || legacyFolderAgentFilePattern.test(fileName)
          || agentEvalFilePattern.test(fileName)) {
          return undefined
        }
        if (parent !== normalize(directory)
          && hasFolderAgentDefinition(parent)
          && extractAgentWorkflowName(file, "__vitehub_agent_workflow__") === undefined) {
          return undefined
        }
        return normalizePathDefinitionName(directory, file)
      },
      createDefinition: ({ file, name }) => ({ handler: file, name, source: "agent-workflow" }),
    }),
  ]).flatMap((definition) => {
    const workflowDefinition = toAgentWorkflowDefinition(definition.handler, definition.name)
    return workflowDefinition ? [workflowDefinition] : []
  })
}

function discoverConfiguredServerAgentWorkflowDefinitions(scanDirs: string[]): DiscoveredWorkflowDefinition[] {
  const definitions = new Map<string, DiscoveredWorkflowDefinition>()

  for (const scanDir of scanDirs) {
    const agentsDir = resolve(scanDir, "agents")
    for (const file of findFolderAgentFiles(agentsDir)) {
      const name = normalize(relative(agentsDir, resolve(file, "..")))
      if (!name || name === ".") {
        continue
      }
      const definition = toAgentWorkflowDefinition(file, name)
      if (definition) {
        registerDefinition(definitions, definition, "agent workflow")
      }
    }
  }

  return sortDefinitions(definitions)
}

function discoverAgentWorkflowDefinitions(roots: string[], serverScanDirs: string[]): DiscoveredWorkflowDefinition[] {
  return mergeDefinitions(
    "agent workflow",
    discoverSuffixAgentWorkflowDefinitions(roots),
    discoverFlatServerAgentWorkflowDefinitions(serverScanDirs),
    discoverConfiguredServerAgentWorkflowDefinitions(serverScanDirs),
  )
}

function discoverWorkflowFolders(scanDirs: string[], source: NonNullable<DiscoveredWorkflowDefinition["source"]>): DiscoveredWorkflowDefinition[] {
  const definitions = new Map<string, DiscoveredWorkflowDefinition>()

  for (const scanDir of scanDirs) {
    const workflowsDir = resolve(scanDir, "workflows")
    for (const directory of findWorkflowFolders(workflowsDir)) {
      const files = readDirEntries(directory)
        .filter(entry => entry.isFile() && isSourceFile(entry.name))
        .map(entry => resolve(directory, entry.name))
        .sort()
      const index = files.find(file => /\/index\.(?:c|m)?[jt]s$/i.test(normalize(file)))
      const steps = files.filter(file => stepFilePattern.test(file.split("/").pop()!))
      if (!index && steps.length === 0) {
        continue
      }

      const relativeName = normalize(relative(workflowsDir, directory))
      registerDefinition(definitions, {
        handler: index || directory,
        name: relativeName,
        source,
        steps,
      }, "workflow")
    }
  }

  return sortDefinitions(definitions)
}

function discoverFlatServerWorkflowDefinitions(scanDirs: string[], source: NonNullable<DiscoveredWorkflowDefinition["source"]>): DiscoveredWorkflowDefinition[] {
  return discoverDefinitions("workflow", [
    createDirectoryDefinitionSource("server-workflows", scanDirs, "workflows", {
      normalizeName(directory, file) {
        const normalizedFile = normalize(file)
        const parent = normalize(resolve(file, ".."))
        if (parent !== normalize(directory) && statSync(parent).isDirectory() && isWorkflowFolder(parent)) {
          return undefined
        }
        const fileName = normalizedFile.split("/").pop()!
        if (fileName.toLowerCase().startsWith("index.") || stepFilePattern.test(fileName)) {
          return undefined
        }
        return normalizePathDefinitionName(directory, file)
      },
      createDefinition: ({ file, name }) => ({ handler: file, name, source }),
    }),
  ])
}

export function discoverWorkflowDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "server-workflows", scanDirs: string[] }
): DiscoveredWorkflowDefinition[] {
  if (options.mode === "server-workflows") {
    return mergeDefinitions(
      "workflow",
      discoverFlatServerWorkflowDefinitions(options.scanDirs, "server-workflows"),
      discoverWorkflowFolders(options.scanDirs, "server-workflows"),
    )
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = roots.map(root => resolve(root, "server"))
  const folderDefinitions = discoverWorkflowFolders(serverScanDirs, "server-workflows")

  return mergeDefinitions(
    "workflow",
    discoverDefinitions("workflow", [
      createSuffixDefinitionSource<DiscoveredWorkflowDefinition>("vite-suffix", roots, workflowSuffixPattern, normalizeSuffixWorkflowName, {
        createDefinition: ({ file, name }) => ({ handler: file, name, source: "vite-suffix" }),
      }),
    ]),
    discoverFlatServerWorkflowDefinitions(serverScanDirs, "server-workflows"),
    folderDefinitions,
    discoverAgentWorkflowDefinitions(roots, serverScanDirs),
  )
}
