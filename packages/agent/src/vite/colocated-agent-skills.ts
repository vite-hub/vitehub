import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"

export interface EncodedColocatedAgentSkillSource {
  content: string
  encoding: "base64"
  materialize: "build"
  mount: ""
  workspacePath: string
}

export function readColocatedAgentSkills(handler: string): Record<string, EncodedColocatedAgentSkillSource> | undefined {
  if (!/^(?:agent|index)\.(?:c|m)?[jt]s$/i.test(basename(handler))) return
  const sourceRoot = dirname(handler)
  const skillsRoot = join(sourceRoot, "skills")
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) return

  const sources: Record<string, EncodedColocatedAgentSkillSource> = {}
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) {
        const workspacePath = relative(sourceRoot, file).replace(/\\/g, "/")
        sources[`__vitehubAgentSkill:${workspacePath}`] = {
          content: readFileSync(file).toString("base64"),
          encoding: "base64",
          materialize: "build",
          mount: "",
          workspacePath,
        }
      }
    }
  }

  visit(skillsRoot)
  return Object.keys(sources).length ? sources : undefined
}
