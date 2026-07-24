import { readColocatedAgentFiles } from "@vite-hub/internal/build/colocated-agent-files"

export interface EncodedColocatedAgentSkillSource {
  content: string
  encoding: "base64"
  materialize: "build"
  mount: ""
  workspacePath: string
}

export function readColocatedAgentSkills(handler: string): Record<string, EncodedColocatedAgentSkillSource> | undefined {
  const files = readColocatedAgentFiles(handler, "skills")
  if (!files) return
  return Object.fromEntries(
    Object.entries(files).map(([path, file]) => {
      const workspacePath = `skills/${path}`
      return [
        `__vitehubAgentSkill:${workspacePath}`,
        {
          ...file,
          materialize: "build",
          mount: "",
          workspacePath,
        },
      ]
    }),
  )
}
