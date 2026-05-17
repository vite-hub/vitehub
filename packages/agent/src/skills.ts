import type { AgentToolSet } from "./types.ts"
import type {
  ReadonlyWorkspaceFacade,
  WorkspaceName,
} from "@vitehub/workspace"

const defaultSkillsDir = "skills"
const skillNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const unsafeDescriptionPattern = /\b(ignore|override|disregard|forget)\b.*\b(instructions?|prompts?|rules?|messages?)\b/i

export interface AgentSkillsOptions {
  authoring?: boolean
  dir?: string
}

export interface ResolvedAgentSkillsOptions {
  authoring: boolean
  dir: string
}

export interface SkillRecord {
  body: string
  description: string
  name: string
  path: string
}

export interface SkillLintResult {
  errors: string[]
  warnings: string[]
}

type WorkspaceFs<Name extends WorkspaceName = WorkspaceName> = ReadonlyWorkspaceFacade<Name>["fs"]

function normalizeSkillDir(dir: string | undefined): string {
  const value = (dir || defaultSkillsDir).trim().replace(/^\/+|\/+$/g, "")
  if (!value || value === "." || value.includes("..") || value.startsWith("./")) {
    throw new TypeError("[vitehub] skills.dir must be a workspace-relative directory.")
  }
  return value
}

export function normalizeAgentSkillsOptions(options: boolean | AgentSkillsOptions | undefined): false | ResolvedAgentSkillsOptions {
  if (!options) return false
  if (options === true) {
    return {
      authoring: false,
      dir: defaultSkillsDir,
    }
  }
  if (typeof options !== "object") {
    throw new TypeError("[vitehub] skills must be a boolean or a plain object.")
  }
  return {
    authoring: options.authoring === true,
    dir: normalizeSkillDir(options.dir),
  }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseSkillMarkdown(content: string): { body: string, frontmatter: Record<string, string> } | undefined {
  const normalized = content.replace(/^\uFEFF/, "")
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return
  const newline = normalized.startsWith("---\r\n") ? "\r\n" : "\n"
  const end = normalized.indexOf(`${newline}---${newline}`, 4)
  if (end === -1) return
  const rawFrontmatter = normalized.slice(4, end)
  const body = normalized.slice(end + newline.length + 3 + newline.length).trim()
  const frontmatter: Record<string, string> = {}
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    frontmatter[match[1]!] = unquote(match[2] || "")
  }
  return { body, frontmatter }
}

function lintSkillFields(input: { body: string, description: string, name: string }, expectedName?: string): SkillLintResult {
  const errors: string[] = []
  const warnings: string[] = []
  const name = input.name.trim()
  const description = input.description.trim()
  const body = input.body.trim()

  if (!name) errors.push("Skill frontmatter requires a name.")
  else if (!skillNamePattern.test(name) || name.includes("--")) errors.push("Skill name must use lowercase letters, numbers, and single hyphens.")
  if (expectedName && name !== expectedName) errors.push(`Skill name must match ${expectedName}.`)
  if (!description) errors.push("Skill frontmatter requires a description.")
  if (/[\r\n]/.test(description)) errors.push("Skill description must be a single line.")
  if (/^\s*[-#>`]/.test(description)) errors.push("Skill description must be plain routing text.")
  if (unsafeDescriptionPattern.test(description)) errors.push("Skill description must not contain instruction override language.")
  if (description.length > 1024) errors.push("Skill description must be 1024 characters or fewer.")
  if (description && !/\bUse when\b/.test(description)) errors.push("Skill description must include \"Use when\".")
  if (!body) errors.push("Skill body must not be empty.")
  if (body.length > 12_000) warnings.push("Skill body is long; consider splitting supporting material into a folder skill later.")

  return { errors, warnings }
}

export function lintSkillMarkdown(content: string, expectedName?: string): SkillLintResult {
  const parsed = parseSkillMarkdown(content)
  if (!parsed) {
    return {
      errors: ["Skill must start with frontmatter."],
      warnings: [],
    }
  }
  return lintSkillFields({
    body: parsed.body,
    description: parsed.frontmatter.description || "",
    name: parsed.frontmatter.name || "",
  }, expectedName)
}

function skillNameFromPath(path: string, dir: string): string | undefined {
  const prefix = `${dir}/`
  if (!path.startsWith(prefix)) return
  const rest = path.slice(prefix.length)
  if (!rest.includes("/") && rest.endsWith(".md")) return rest.slice(0, -3)
  const folderMatch = /^([^/]+)\/SKILL\.md$/.exec(rest)
  return folderMatch?.[1]
}

export async function discoverSkills<Name extends WorkspaceName>(
  fs: WorkspaceFs<Name>,
  options: ResolvedAgentSkillsOptions,
): Promise<{ skills: SkillRecord[], warnings: string[] }> {
  let entries: Array<{ path: string, type: string }>
  try {
    entries = await fs.list(options.dir as never, { recursive: true })
  }
  catch {
    return { skills: [], warnings: [] }
  }

  const skills: SkillRecord[] = []
  const warnings: string[] = []
  const errors: string[] = []
  for (const entry of entries) {
    if (entry.type !== "file") continue
    const expectedName = skillNameFromPath(entry.path, options.dir)
    if (!expectedName) continue
    try {
      const content = await fs.readFile(entry.path as never)
      const parsed = parseSkillMarkdown(content)
      const lint = lintSkillMarkdown(content, expectedName)
      if (!parsed || lint.errors.length) {
        errors.push(`${entry.path}: ${lint.errors.join(" ")}`)
        continue
      }
      warnings.push(...lint.warnings.map(warning => `${entry.path}: ${warning}`))
      skills.push({
        body: parsed.body,
        description: parsed.frontmatter.description!,
        name: parsed.frontmatter.name!,
        path: entry.path,
      })
    }
    catch (error) {
      errors.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (errors.length) {
    throw new Error([
      "[vitehub:agent] Invalid Skills:",
      ...errors.map(error => `- ${error}`),
    ].join("\n"))
  }

  return {
    skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    warnings,
  }
}

export function renderSkillsInstructions(result: { skills: SkillRecord[], warnings?: string[] }, options: ResolvedAgentSkillsOptions): string | undefined {
  const lines = [
    `Skills live under /workspace/${options.dir}.`,
    "Use the available skill descriptions to decide when to inspect and apply a skill.",
  ]

  if (result.skills.length) {
    lines.push("", "Available skills:")
    lines.push(...result.skills.map(skill => `- name: ${JSON.stringify(skill.name)} description: ${JSON.stringify(skill.description)} path: ${JSON.stringify(skill.path)}`))
  }
  else {
    lines.push("", "Available skills: none.")
  }

  if (result.warnings?.length) {
    lines.push("", "Skill warnings:")
    lines.push(...result.warnings.map(warning => `- ${warning}`))
  }

  if (options.authoring) {
    lines.push(
      "",
      "Skill authoring rules:",
      "- Draft the skill in conversation first and write it only after explicit user confirmation.",
      `- Prefer flat files at ${options.dir}/<name>.md.`,
      "- Use folder skills only when supporting files are needed.",
      "- Skill descriptions are routing text, must be third-person, and must include \"Use when ...\".",
      "- Skills describe behavior and must not name implementation-specific tools.",
    )
  }

  return lines.join("\n")
}

function normalizeWritePath(path: string): string {
  const normalized = path.trim().replace(/^\/+/, "").replace(/\/+/g, "/")
  return normalized.startsWith("workspace/") ? normalized.slice("workspace/".length) : normalized
}

function expectedSkillNameForWrite(path: string, dir: string): false | string | undefined {
  const normalized = normalizeWritePath(path)
  const prefix = `${dir}/`
  if (!normalized.startsWith(prefix)) return
  const rest = normalized.slice(prefix.length)
  if (!rest.includes("/") && rest.endsWith(".md")) return rest.slice(0, -3)
  const folderMatch = /^([^/]+)\/SKILL\.md$/.exec(rest)
  if (folderMatch) return folderMatch[1]
  const supportFileMatch = /^([^/]+)\/[^/]+$/.exec(rest)
  if (supportFileMatch && skillNamePattern.test(supportFileMatch[1]!) && !supportFileMatch[1]!.includes("--")) return false
  throw new Error(`[vitehub:agent] Skill writes must target ${dir}/<name>.md or ${dir}/<name>/SKILL.md.`)
}

function validateSkillWrite(path: string, content: unknown, options: ResolvedAgentSkillsOptions): void {
  const expectedName = expectedSkillNameForWrite(path, options.dir)
  if (!expectedName) return
  if (typeof content !== "string") {
    throw new Error("[vitehub:agent] Skill files must be written as Markdown text.")
  }
  const lint = lintSkillMarkdown(content, expectedName)
  if (lint.errors.length) {
    throw new Error(`[vitehub:agent] Invalid skill ${normalizeWritePath(path)}: ${lint.errors.join(" ")}`)
  }
}

export function withSkillWriteValidation<TTools extends AgentToolSet | undefined>(tools: TTools, options: false | ResolvedAgentSkillsOptions | undefined): TTools {
  if (!tools || !options || !options.authoring) return tools
  const writeFile = tools.writeFile
  if (!writeFile || typeof writeFile !== "object" || typeof writeFile.execute !== "function") return tools
  const execute = writeFile.execute
  return {
    ...tools,
    writeFile: {
      ...writeFile,
      async execute(input: unknown, ...args: unknown[]) {
        const path = typeof input === "object" && input && "path" in input ? String((input as { path: unknown }).path) : ""
        const content = typeof input === "object" && input && "content" in input ? (input as { content: unknown }).content : undefined
        validateSkillWrite(path, content, options)
        return await (execute as (input: unknown, ...args: unknown[]) => unknown)(input, ...args)
      },
    },
  } as TTools
}

export function mergeAgentToolSets(base: AgentToolSet | undefined, extra: AgentToolSet | undefined): AgentToolSet | undefined {
  if (!base && !extra) return
  const result: AgentToolSet = { ...(base || {}) }
  for (const [name, tool] of Object.entries(extra || {})) {
    if (name in result) throw new Error(`[vitehub:agent] Tool "${name}" is already defined.`)
    result[name] = tool
  }
  return result
}

export async function resolveSkillsInstructions<Name extends WorkspaceName>(
  workspace: ReadonlyWorkspaceFacade<Name>,
  options: ResolvedAgentSkillsOptions,
): Promise<string | undefined> {
  return renderSkillsInstructions(await discoverSkills(workspace.fs, options), options)
}
