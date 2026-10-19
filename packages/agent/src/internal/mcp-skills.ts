import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

import type { AgentCapabilityWorkspaceContribution } from "../types.ts"
import type { WorkspaceDefinition, WorkspaceSourceInput } from "@vite-hub/workspace"

/** Provider Agents such as Codex discover Skills in this Workspace directory. */
export const mcpSkillsRoot = ".agents/skills"

const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/
const pageLimit = 10
const fileLimit = 64
const byteLimit = 1024 * 1024

export interface McpSkillFile {
  content: string
  mediaType: string
  path: string
}

export interface McpSkill {
  files: McpSkillFile[]
  name: string
}

/** The resource methods of an MCP client. Direct clients without them serve no Skills. */
interface McpResourceClient {
  listResources: (options?: { params?: { cursor?: string }, options?: { signal?: AbortSignal } }) => Promise<unknown>
  readResource: (args: { uri: string, options?: { signal?: AbortSignal } }) => Promise<unknown>
}

function hasResourceMethods(client: object): client is McpResourceClient {
  return "listResources" in client && hasRuntimeType(client.listResources, "function")
    && "readResource" in client && hasRuntimeType(client.readResource, "function")
}

function unsafeSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === ".." || segment.includes("\\")) return true
  for (const char of segment) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7F) return true
  }
  return false
}

/** The Skill name and file path of a `skill://<name>/<path>` resource URI, or nothing for any other or unsafe URI. */
function skillFile(uri: unknown, normalizeSafeWorkspacePath: (path: string) => string): { name: string, path: string, uri: string } | undefined {
  if (!hasRuntimeType(uri, "string")) return
  const match = /^skill:\/\/([^/]+)\/(.+)$/.exec(uri)
  const name = match?.[1]
  const path = match?.[2]
  if (!name || !path || !skillNamePattern.test(name)) return
  if (path.split("/").some(unsafeSegment)) return
  const workspacePath = `${mcpSkillsRoot}/${name}/${path}`
  try {
    if (normalizeSafeWorkspacePath(workspacePath) !== workspacePath) return
  }
  catch {
    return
  }
  return { name, path, uri }
}

/** A server without the resources capability serves no Skills. */
function isUnsupportedResources(error: unknown): boolean {
  if (!isRuntimeRecord(error)) return false
  return error.code === -32601
    || (hasRuntimeType(error.message, "string") && error.message === "Server does not support resources")
}

async function readText(client: McpResourceClient, uri: string, signal: AbortSignal | undefined): Promise<{ text: string, mimeType?: string } | undefined> {
  const result = await client.readResource({ uri, ...(signal ? { options: { signal } } : {}) })
  const contents = isRuntimeRecord(result) && Array.isArray(result.contents) ? result.contents : []
  for (const item of contents) {
    if (isRuntimeRecord(item) && item.uri === uri && hasRuntimeType(item.text, "string")) {
      return { text: item.text, ...(hasRuntimeType(item.mimeType, "string") ? { mimeType: item.mimeType } : {}) }
    }
  }
}

/**
 * Read the Agent Skills that a server serves as `skill://<name>/<path>` resources (the MCP Skills
 * extension). Only the text files of Skills that have a `SKILL.md` are kept. A Skill is kept whole
 * or left out, so the file and byte limits never cut a Skill in half.
 */
export async function readMcpSkills(client: object, signal?: AbortSignal): Promise<McpSkill[]> {
  if (!hasResourceMethods(client)) return []
  // Loaded here so that importing mcp() does not load the Workspace package.
  const { normalizeSafeWorkspacePath } = await import("@vite-hub/workspace")
  const listed: Array<{ name: string, path: string, uri: string }> = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < pageLimit; page++) {
      const result = await client.listResources({
        ...(cursor ? { params: { cursor } } : {}),
        ...(signal ? { options: { signal } } : {}),
      })
      const resources = isRuntimeRecord(result) && Array.isArray(result.resources) ? result.resources : []
      for (const resource of resources) {
        const file = skillFile(isRuntimeRecord(resource) ? resource.uri : undefined, normalizeSafeWorkspacePath)
        if (file) listed.push(file)
      }
      cursor = isRuntimeRecord(result) && hasRuntimeType(result.nextCursor, "string") && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
  }
  catch (error) {
    if (isUnsupportedResources(error)) return []
    throw error
  }
  const byName = new Map<string, Array<{ path: string, uri: string }>>()
  for (const file of listed) {
    const files = byName.get(file.name) ?? []
    if (!files.some(existing => existing.path === file.path)) files.push(file)
    byName.set(file.name, files)
  }
  const skills: McpSkill[] = []
  let files = 0
  let bytes = 0
  for (const [name, entries] of byName) {
    if (!entries.some(entry => entry.path === "SKILL.md")) continue
    if (files + entries.length > fileLimit) continue
    const contents = await Promise.all(entries.map(entry => readText(client, entry.uri, signal)))
    const skillFiles: McpSkillFile[] = []
    let skillBytes = 0
    for (const [index, content] of contents.entries()) {
      if (!content) continue
      skillBytes += new TextEncoder().encode(content.text).byteLength
      skillFiles.push({ content: content.text, mediaType: content.mimeType ?? "text/markdown", path: entries[index]!.path })
    }
    if (!skillFiles.some(file => file.path === "SKILL.md") || bytes + skillBytes > byteLimit) continue
    files += entries.length
    bytes += skillBytes
    skills.push({ files: skillFiles, name })
  }
  return skills
}

/** Workspace paths that the Agent's own Sources occupy, as the Capability runtime compares them. */
async function occupiedPaths(definition: WorkspaceDefinition | undefined): Promise<string[]> {
  const { normalizeWorkspaceSourceMetadata } = await import("@vite-hub/workspace/runtime")
  const paths: string[] = []
  for (const [key, source] of Object.entries(definition?.sources ?? {})) {
    let metadata: ReturnType<typeof normalizeWorkspaceSourceMetadata>
    try {
      metadata = normalizeWorkspaceSourceMetadata(key, source)
    }
    catch {
      continue
    }
    if (metadata.requestOnly) continue
    paths.push(...(metadata.probeKeys?.length
      ? metadata.probeKeys.map(path => [metadata.mountPath, path].filter(Boolean).join("/"))
      : [metadata.mountPath]))
  }
  return paths
}

function pathsOverlap(left: string, right: string): boolean {
  const contains = (container: string, path: string) => !container || path === container || path.startsWith(`${container}/`)
  return contains(left, right) || contains(right, left)
}

/**
 * Workspace Sources for the Skills discovered on each server, at `.agents/skills/<name>/<path>`.
 * A Skill directory that one of the Agent's own Sources already occupies is left out, so the
 * Agent's own Skill wins. Servers are in configured order, and the first server that serves a name wins.
 */
export async function mcpSkillsWorkspaceContribution(
  servers: ReadonlyArray<{ server: string, skills: readonly McpSkill[] }>,
  definition: WorkspaceDefinition | undefined,
  materializationPaths: readonly string[] = [],
): Promise<AgentCapabilityWorkspaceContribution | undefined> {
  // The MCP capability reserves this root for its own transient contribution.
  // It must not hide MCP Skills from itself; only other capabilities' materialization
  // paths represent Agent-owned content that takes precedence.
  const occupied = [...await occupiedPaths(definition), ...materializationPaths.filter(path => path !== mcpSkillsRoot)]
  const taken = new Set<string>()
  const sources: Record<string, WorkspaceSourceInput> = {}
  for (const { server, skills } of servers) {
    for (const skill of skills) {
      const directory = `${mcpSkillsRoot}/${skill.name}`
      if (taken.has(skill.name) || occupied.some(path => pathsOverlap(path, directory))) continue
      taken.add(skill.name)
      for (const file of skill.files) {
        const workspacePath = `${directory}/${file.path}`
        sources[`mcp.skills.${server}:${workspacePath}`] = { content: file.content, mediaType: file.mediaType, workspacePath }
      }
    }
  }
  return Object.keys(sources).length ? { sources } : undefined
}

/** The value that the MCP inspection shows under Skills for one server. */
export function mcpSkillsInspectionValue(result: McpSkill[] | { error: unknown } | "off" | "no-workspace"): string {
  if (result === "off") return "Off"
  if (result === "no-workspace") return "No Workspace"
  if (!Array.isArray(result)) {
    const error = result.error
    const message = isRuntimeRecord(error) && hasRuntimeType(error.message, "string") ? error.message : String(error)
    return `Discovery failed: ${message.slice(0, 200)}`
  }
  return result.map(skill => skill.name).join(", ") || "None"
}
