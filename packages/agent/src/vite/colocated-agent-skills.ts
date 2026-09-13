import { readColocatedAgentFiles, resolveColocatedAgentFilesRoot } from "@vite-hub/internal/build/colocated-agent-files"

export interface EncodedColocatedAgentSkillSource {
  content: string
  encoding: "base64"
  materialize: "startup"
  mount: ""
  workspacePath: string
}

export function resolveColocatedAgentSkillsRoot(handler: string): string | undefined {
  return resolveColocatedAgentFilesRoot(handler, "skills")
}

export function readColocatedAgentSkills(handler: string): Record<string, EncodedColocatedAgentSkillSource> | undefined {
  const files = readColocatedAgentFiles(handler, "skills")
  if (!files) return
  return Object.fromEntries(
    Object.entries(files).map(([path, file]) => {
      const workspacePath = `.agents/skills/${path}`
      return [
        `__vitehubAgentSkill:${workspacePath}`,
        {
          ...file,
          materialize: "startup",
          mount: "",
          workspacePath,
        },
      ]
    }),
  )
}
