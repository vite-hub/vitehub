import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
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
import { maskSourceLiterals } from "@vite-hub/internal/source-scanner"

import type { DiscoveredWorkflowDefinition } from "./types.ts"

const workflowSuffixPattern = /\.workflow\.(?:c|m)?[jt]s$/i
const agentSuffixPattern = /\.agent\.(?:c|m)?[jt]s$/i
const sourceFilePattern = /\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
const stepFilePattern = /^\d+[.-].*\.(?:c|m)?[jt]s$/i
const folderAgentFilePattern = /^agent\.(?:c|m)?[jt]s$/i
const folderAgentIndexFilePattern = /^index\.(?:c|m)?[jt]s$/i
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

function findDefineAgentObjectStart(masked: string, start: number): number | undefined {
  let index = start
  while (/\s/.test(masked[index] || "")) index++
  if (masked[index] === "<") {
    let depth = 0
    do {
      if (masked[index] === "<") depth++
      else if (masked[index] === ">" && masked[index - 1] !== "=") depth--
      index++
    } while (index < masked.length && depth > 0)
  }
  while (/\s/.test(masked[index] || "")) index++
  if (masked[index++] !== "(") return undefined
  while (/\s/.test(masked[index] || "")) index++
  if (masked[index] === "{") return index
  const options = /^([A-Za-z_$][\w$]*)\b/.exec(masked.slice(index))?.[1]
  if (options) {
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${options}\\s*(?::(?:=>|[^=])*?)?=\\s*\\{`).exec(masked)
    if (declaration) return declaration.index + declaration[0].lastIndexOf("{")
  }
  return undefined
}

function agentFactoryNames(source: string): string[] {
  const names = new Set(["defineAgent"])
  for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*["']@vite-hub\/agent["']/g)) {
    for (const specifier of match[1]!.split(",")) {
      const alias = /^\s*defineAgent\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(specifier)?.[1]
      if (alias) names.add(alias)
    }
  }
  return [...names]
}

function findAgentObjectStart(source: string, masked: string): number | undefined {
  for (const factory of agentFactoryNames(source)) {
    const inline = new RegExp(`\\bexport\\s+default\\s+${factory}\\b`).exec(masked)
    if (inline) return findDefineAgentObjectStart(masked, inline.index + inline[0].length)
  }

  const exported = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/.exec(masked)
  if (!exported) return undefined
  for (const factory of agentFactoryNames(source)) {
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${exported[1]}\\s*(?::(?:=>|[^=])*?)?=\\s*${factory}\\b`).exec(masked)
    if (declaration) return findDefineAgentObjectStart(masked, declaration.index + declaration[0].length)
  }
  return undefined
}

function hasExportedDefineAgent(source: string, masked: string): boolean {
  if (agentFactoryNames(source).some(factory => new RegExp(`\\bexport\\s+default\\s+${factory}\\b`).test(masked))) return true
  const exported = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/.exec(masked)
  return Boolean(exported
    && agentFactoryNames(source).some(factory => new RegExp(`\\b(?:const|let|var)\\s+${exported[1]}\\s*(?::(?:=>|[^=])*?)?=\\s*${factory}\\b`).test(masked)))
}

function findUnmaskedSourceMatch(source: string, masked: string, pattern: RegExp, prefix: RegExp): RegExpMatchArray | undefined {
  return [...source.matchAll(pattern)].find(match => prefix.test(masked.slice(match.index)))
}

function resolveAgentReExport(file: string, source: string, masked: string): string | undefined {
  const direct = findUnmaskedSourceMatch(source, masked, /\bexport\s+\{\s*default\s*\}\s+from\s*(["'])([^"']+)\1/g, /^export\s+\{\s*default\s*\}\s+from\b/)
  const exported = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/.exec(masked)
  const imported = exported && findUnmaskedSourceMatch(source, masked, new RegExp(`\\bimport\\s+${exported[1]}\\s+from\\s*(["'])([^"']+)\\1`, "g"), /^import\b/)
  const specifier = direct?.[2] || imported?.[2]
  if (!specifier?.startsWith(".")) return undefined
  const target = resolve(file, "..", specifier)
  const extensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]
  const sourceTarget = target.replace(/\.(?:c|m)?js$/i, "")
  for (const candidate of [target, ...extensions.map(extension => `${target}${extension}`), ...extensions.map(extension => `${sourceTarget}${extension}`), ...extensions.map(extension => resolve(target, `index${extension}`))]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

function isFolderAgentImplementationTarget(file: string): boolean {
  const fileName = normalize(file).split("/").pop()!
  if (/^definition\.(?:c|m)?[jt]s$/i.test(fileName)) return true
  return /^index\.(?:c|m)?[jt]s$/i.test(fileName)
    && normalize(resolve(file, "../..")).split("/").pop() === "definition"
}

function extractAgentRuntime(file: string, seen = new Set<string>()): { masked?: string, raw?: string } | undefined {
  if (seen.has(file)) return undefined
  seen.add(file)
  const source = readFileSync(file, "utf8")
  const masked = maskSourceLiterals(source)
  const start = findAgentObjectStart(source, masked)
  if (start === undefined) {
    const target = resolveAgentReExport(file, source, masked)
    if (target) return extractAgentRuntime(target, seen)
    if (hasExportedDefineAgent(source, masked)) return {}
    return /\bexport\s+default\s+[A-Za-z_$][\w$]*Agent\b/.test(masked) ? {} : undefined
  }
  let depth = 0
  for (let index = start; index < masked.length; index++) {
    if (masked[index] === "{") {
      depth++
    }
    else if (masked[index] === "}" && --depth === 0) {
      return {}
    }
    else if (depth === 1) {
      const previous = masked.slice(0, index).trimEnd().at(-1)
      if ((previous === "{" || previous === ",") && /^runtime\s*(?:,|})/.test(masked.slice(index))) {
        return { masked: "runtime", raw: "runtime" }
      }
      const runtimeProperty = /^runtime\s*:/.test(masked.slice(index))
        || ((previous === "{" || previous === ",") && /^["']runtime["']\s*:/.test(source.slice(index)))
      if (!runtimeProperty) continue
      const colon = source.indexOf(":", index + 7)
      let end = colon + 1
      let nested = 0
      for (; end < masked.length; end++) {
        if ("([{".includes(masked[end] || "")) nested++
        else if (")]}".includes(masked[end] || "")) {
          if (nested === 0) break
          nested--
        }
        else if (masked[end] === "," && nested === 0) break
      }
      return {
        masked: masked.slice(colon + 1, end).trim(),
        raw: source.slice(colon + 1, end).trim(),
      }
    }
  }
  return {}
}

function extractAgentWorkflowName(file: string, fallbackName: string): string | undefined {
  const runtime = extractAgentRuntime(file)
  if (!runtime) return undefined
  const workflowPattern = /^(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*)*workflow\s*\(\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*)*(["'`])([^"'`]+)\1\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*)*\)(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$)))*\s*$/
  const match = workflowPattern.exec(runtime.raw || "")
  if (match) {
    return match[2] || fallbackName
  }
  if (/^false(?:\s+as\s+const)?$/.test(runtime.masked || "")) return undefined
  const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(runtime.masked || "")?.[1]
  if (shorthand) {
    const source = readFileSync(file, "utf8")
    const masked = maskSourceLiterals(source)
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${shorthand}\\s*(?::(?:=>|[^=])*?)?=\\s*`).exec(masked)
    if (declaration) {
      const start = declaration.index + declaration[0].length
      let end = start
      let depth = 0
      for (; end < masked.length; end++) {
        if ("([{".includes(masked[end] || "")) depth++
        else if (")]}".includes(masked[end] || "")) depth--
        else if (depth === 0 && (masked[end] === ";" || masked[end] === "\n")) break
      }
      const initializer = source.slice(start, end).trim()
      if (/^false(?:\s+as\s+const)?$/.test(masked.slice(start, end).trim())) return undefined
      const shorthandWorkflow = workflowPattern.exec(initializer)
      if (shorthandWorkflow) return shorthandWorkflow[2] || fallbackName
    }
  }
  return fallbackName
}

function toAgentWorkflowDefinition(file: string, fallbackName: string): DiscoveredWorkflowDefinition | undefined {
  const name = extractAgentWorkflowName(file, fallbackName)
  return name ? { agentIdentity: fallbackName, handler: file, name, source: "agent-workflow" } : undefined
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
  return readDirEntries(directory).some(entry => entry.isFile() && (folderAgentFilePattern.test(entry.name) || folderAgentIndexFilePattern.test(entry.name)) && isSourceFile(entry.name))
}

function findFolderAgentFiles(agentsDir: string): string[] {
  const files: string[] = []
  for (const entry of readDirEntries(agentsDir)) {
    if (entry.name.startsWith(".")) {
      continue
    }
    const absolute = resolve(agentsDir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if ((entry.name === "workspace" || entry.name === "skills") && hasFolderAgentDefinition(agentsDir)) continue
      files.push(...findFolderAgentFiles(absolute))
      continue
    }
    if (entry.isFile()
      && (folderAgentFilePattern.test(entry.name) || folderAgentIndexFilePattern.test(entry.name))
      && !(folderAgentIndexFilePattern.test(entry.name) && readDirEntries(agentsDir).some(sibling => sibling.isFile() && folderAgentFilePattern.test(sibling.name)))
      && isSourceFile(entry.name)) {
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
  const folderAgentFiles = scanDirs.flatMap(scanDir => findFolderAgentFiles(resolve(scanDir, "agents")))
  const folderAgentDirs = new Set(folderAgentFiles.map(file => normalize(resolve(file, ".."))))
  const folderAgentTargets = new Set(folderAgentFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8")
    const target = resolveAgentReExport(file, source, maskSourceLiterals(source))
    const relativeTarget = target && normalize(relative(resolve(file, ".."), target))
    return target && relativeTarget && relativeTarget !== ".." && !relativeTarget.startsWith("../") && isFolderAgentImplementationTarget(target)
      ? [normalize(target)]
      : []
  }))
  return discoverDefinitions("agent workflow", [
    createDirectoryDefinitionSource<DiscoveredWorkflowDefinition>("agent-workflow", scanDirs, "agents", {
      normalizeName(directory, file) {
        const fileName = normalize(file).split("/").pop()!
        const parent = normalize(resolve(file, ".."))
        const name = normalizePathDefinitionName(directory, file)
        if (folderAgentTargets.has(normalize(file))) return undefined
        if ([...folderAgentDirs].some((agentDir) => {
          const path = normalize(relative(agentDir, file))
          return path === "workspace" || path.startsWith("workspace/") || path === "skills" || path.startsWith("skills/")
        })) return undefined
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
        if (/^index\.(?:c|m)?[jt]s$/i.test(fileName) && hasFolderAgentDefinition(resolve(file, ".."))) {
          return undefined
        }
        return name
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
    const files = findFolderAgentFiles(agentsDir)
    const targets = new Set(files.flatMap((file) => {
      const source = readFileSync(file, "utf8")
      const target = resolveAgentReExport(file, source, maskSourceLiterals(source))
      const relativeTarget = target && normalize(relative(resolve(file, ".."), target))
      return target && relativeTarget && relativeTarget !== ".." && !relativeTarget.startsWith("../") ? [normalize(target)] : []
    }))
    for (const file of files) {
      if (targets.has(normalize(file))) continue
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
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[], serverDirs?: string[] }
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
  const serverScanDirs = options.serverDirs ?? roots.map(root => resolve(root, "server"))
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
