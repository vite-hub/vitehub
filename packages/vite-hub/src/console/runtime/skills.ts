import * as v from "valibot"

export const consoleSkillsSchema: v.GenericSchema<unknown, {
  agents: string[]
  agent?: string
  files: { path: string, size: number }[]
}> = v.object({
  agents: v.array(v.string()),
  agent: v.optional(v.string()),
  files: v.array(v.object({ path: v.string(), size: v.number() })),
})
export const consoleSkillFileSchema: v.GenericSchema<unknown, { path: string, content: string, size: number }> = v.object({ path: v.string(), content: v.string(), size: v.number() })
export type ConsoleSkills = v.InferOutput<typeof consoleSkillsSchema>
export type ConsoleSkillFile = v.InferOutput<typeof consoleSkillFileSchema>
