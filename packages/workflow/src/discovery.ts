import { readdirSync, statSync } from "node:fs"
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
const sourceFilePattern = /\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
const stepFilePattern = /^\d+[.-].*\.(?:c|m)?[jt]s$/i

function normalizeSuffixWorkflowName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, workflowSuffixPattern, { stripPrefix: "src/" })
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
    createDirectoryDefinitionSource("nitro-server-workflows", scanDirs, "workflows", {
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
  | { mode: "nitro-server-workflows", scanDirs: string[] }
): DiscoveredWorkflowDefinition[] {
  if (options.mode === "nitro-server-workflows") {
    return mergeDefinitions(
      "workflow",
      discoverFlatServerWorkflowDefinitions(options.scanDirs, "nitro-server-workflows"),
      discoverWorkflowFolders(options.scanDirs, "nitro-server-workflows"),
    )
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = roots.map(root => resolve(root, "server"))
  const folderDefinitions = discoverWorkflowFolders(serverScanDirs, "nitro-server-workflows")

  return mergeDefinitions(
    "workflow",
    discoverDefinitions("workflow", [
      createSuffixDefinitionSource<DiscoveredWorkflowDefinition>("vite-suffix", roots, workflowSuffixPattern, normalizeSuffixWorkflowName, {
        createDefinition: ({ file, name }) => ({ handler: file, name, source: "vite-suffix" }),
      }),
    ]),
    discoverFlatServerWorkflowDefinitions(serverScanDirs, "nitro-server-workflows"),
    folderDefinitions,
  )
}
