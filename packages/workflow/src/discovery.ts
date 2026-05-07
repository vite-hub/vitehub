import { readFileSync, readdirSync, statSync } from "node:fs"
import { relative } from "node:path"

import { normalize, resolve } from "pathe"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  listSourceFiles,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  registerDefinition,
  resolveDefinitionScanRoots,
  sortDefinitions,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredWorkflowDefinition } from "./types.ts"

const workflowSuffixPattern = /\.workflow\.(?:c|m)?[jt]s$/i
const sourceFilePattern = /\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
const stepFilePattern = /^\d+[.-].*\.(?:c|m)?[jt]s$/i
const createWorkflowPattern = /\bcreateWorkflow\b/g

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

function isQuote(char: string) {
  return char === "\"" || char === "'" || char === "`"
}

function skipQuoted(source: string, index: number) {
  const quote = source[index]
  index += 1
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === quote) {
      return index + 1
    }
    index += 1
  }
  return index
}

function findMatching(source: string, index: number, open: string, close: string) {
  let depth = 0
  for (let current = index; current < source.length; current++) {
    const char = source[current]
    if (isQuote(char)) {
      current = skipQuoted(source, current) - 1
      continue
    }
    if (char === open) {
      depth += 1
    }
    else if (char === close) {
      depth -= 1
      if (depth === 0) {
        return current
      }
    }
  }
}

function splitTopLevel(source: string, separator = ",") {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (isQuote(char)) {
      index = skipQuoted(source, index) - 1
      continue
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1
    }
    else if (char === ")" || char === "}" || char === "]") {
      depth -= 1
    }
    else if (char === separator && depth === 0) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(source.slice(start).trim())
  return parts
}

function readStringLiteral(source: string) {
  const match = source.trim().match(/^(['"])([^'"]+)\1$/)
  return match?.[2]
}

function findCallArguments(source: string, start: number) {
  let index = start + "createWorkflow".length
  while (/\s/.test(source[index] || "")) {
    index += 1
  }
  if (source[index] === "<") {
    const genericEnd = findMatching(source, index, "<", ">")
    if (genericEnd === undefined) {
      return
    }
    index = genericEnd + 1
  }
  while (/\s/.test(source[index] || "")) {
    index += 1
  }
  if (source[index] !== "(") {
    return
  }
  const callEnd = findMatching(source, index, "(", ")")
  if (callEnd === undefined) {
    return
  }
  return splitTopLevel(source.slice(index + 1, callEnd))
}

function readObjectWorkflowName(argument: string) {
  const objectSource = argument.trim()
  if (!objectSource.startsWith("{") || !objectSource.endsWith("}")) {
    return
  }
  const properties = splitTopLevel(objectSource.slice(1, -1))
  let name: string | undefined
  let hasHandler = false
  for (const property of properties) {
    const [key, ...valueParts] = splitTopLevel(property, ":")
    const value = valueParts.join(":").trim()
    if (key?.trim() === "name") {
      name = readStringLiteral(value)
    }
    else if (key?.trim() === "handler") {
      hasHandler = value.length > 0
    }
  }
  return hasHandler ? name : undefined
}

function isOptionsOnlyWorkflowCall(argumentsList: string[]) {
  return argumentsList.length === 2 && argumentsList[1]?.trim().startsWith("{")
}

function discoverInlineWorkflowNames(source: string) {
  const names: string[] = []
  for (const match of source.matchAll(createWorkflowPattern)) {
    const argumentsList = findCallArguments(source, match.index!)
    if (!argumentsList?.length) {
      continue
    }

    const objectName = readObjectWorkflowName(argumentsList[0]!)
    if (objectName) {
      names.push(objectName)
      continue
    }

    if (isOptionsOnlyWorkflowCall(argumentsList)) {
      continue
    }

    const stringName = readStringLiteral(argumentsList[0]!)
    if (stringName && argumentsList.length > 1) {
      names.push(stringName)
    }
  }
  return names
}

function resolveInlineWorkflowScanRoots(options: { rootDir: string, scanDirs?: string[] }) {
  if (options.scanDirs?.length) {
    return options.scanDirs
  }
  return [resolve(options.rootDir, "server")]
}

export function discoverInlineWorkflowDefinitions(options: { rootDir: string, scanDirs?: string[] }): DiscoveredWorkflowDefinition[] {
  const definitions = new Map<string, DiscoveredWorkflowDefinition>()
  const roots = resolveInlineWorkflowScanRoots(options)
  const seenFiles = new Set<string>()

  for (const root of roots) {
    for (const file of listSourceFiles(root)) {
      if (seenFiles.has(file)) {
        continue
      }
      seenFiles.add(file)
      const contents = readFileSync(file, "utf8")
      for (const name of discoverInlineWorkflowNames(contents)) {
        registerDefinition(definitions, {
          handler: file,
          name,
          source: "inline",
        }, "workflow")
      }
    }
  }

  return sortDefinitions(definitions)
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
  return mergeDefinitions(
    "workflow",
    discoverInlineWorkflowDefinitions(options),
    discoverDefinitions("workflow", [
      createSuffixDefinitionSource("vite-suffix", roots, workflowSuffixPattern, normalizeSuffixWorkflowName),
    ]),
    discoverFlatServerWorkflowDefinitions(serverScanDirs, "nitro-server-workflows"),
    discoverWorkflowFolders(serverScanDirs, "nitro-server-workflows"),
  )
}
