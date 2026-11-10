import { inspectAgentSkillFiles } from "@vite-hub/agent/server/internal"
import { getConsoleAgentDefinition, getConsoleAgents } from "./agents.ts"
import { consoleRequestError } from "./request.ts"
import type { ConsoleSkillFile, ConsoleSkills } from "../skills.ts"

const maxFileBytes = 512 * 1024

function skillFiles(agent: string) {
  const definition = getConsoleAgentDefinition(agent, "inspect")
  return definition ? inspectAgentSkillFiles(definition) : []
}

/** The bundled Skill files of an Agent, or one bundled text file, for the `skills.inspect` operation. */
export async function inspectConsoleSkills(input: { agent?: string, path?: string }): Promise<ConsoleSkills | ConsoleSkillFile> {
  const agents = getConsoleAgents()
  // Without a chosen Agent, open the first one that bundles Skills.
  const agent = input.agent ?? agents.find(name => skillFiles(name).length) ?? agents[0]
  const path = input.path
  if (agent === undefined && path === undefined) return { agents: [...agents], files: [] }
  if (agent === undefined || !agents.includes(agent)) throw consoleRequestError(404, "Agent not found.")
  const files = skillFiles(agent)
  if (path !== undefined) {
    const file = files.find(file => file.path === path)
    if (!file) throw consoleRequestError(404, "This file is not bundled with this Agent.")
    if (file.size > maxFileBytes) throw consoleRequestError(413, "This file is too large to preview. The Console limit is 512 KiB.")
    let content: string
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(file.read())
    }
    catch {
      throw consoleRequestError(415, "Binary files cannot be previewed as text.")
    }
    if (content.includes("\0")) throw consoleRequestError(415, "Binary files cannot be previewed as text.")
    return { path: file.path, content, size: file.size }
  }
  return { agent, agents: [...agents], files: files.map(file => ({ path: file.path, size: file.size })) }
}
