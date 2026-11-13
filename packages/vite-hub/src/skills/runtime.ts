import { isSkillSettings } from "../skills.ts"
import { servedSkillsRegistryKey } from "./registry.ts"

import type { Skill, SkillList, SkillSettings } from "../skills.ts"

/** One skill that the app serves, as the Console and `vitehub served-skills` show it. */
export interface ServedSkillSummary {
  /** The skill name. The Console lists rows by `id`. */
  id: string
  name: string
  description: string
  enabled: boolean
  files: number
}

/** A failure with the fields that every surface reports. */
class ServedSkillsError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fix?: string) {
    super(message)
  }
}

const registryKey: unique symbol = Symbol.for(servedSkillsRegistryKey)
const scope = globalThis as typeof globalThis & { [registryKey]?: () => Promise<Record<string, unknown>> }

const exportFix = "Default-export `skillSettings(skills, { store })` from `server/skills.ts`, or a skill list to only list them."

/** The default export of `server/skills.ts`, or its `skills` export: switches, or a plain list that is always on. */
async function served(): Promise<SkillSettings | SkillList> {
  const load = scope[registryKey]
  if (!load) throw new ServedSkillsError("This runtime has no `server/skills.ts`.", 503, "SERVED_SKILLS_UNAVAILABLE", "Add `server/skills.ts` and build again.")
  const module = await load()
  const value = Object.hasOwn(module, "default") ? module.default : module.skills
  if (isSkillSettings(value)) return value
  // SAFETY: A list function is only called, and an array is checked item by item below.
  if (typeof value === "function") return value as SkillList
  if (Array.isArray(value)) return value
  throw new ServedSkillsError("`server/skills.ts` exports no skills.", 500, "SERVED_SKILLS_INVALID_EXPORT", exportFix)
}

function summary(skill: Skill, enabled: boolean): ServedSkillSummary {
  return { description: skill.description, enabled, files: skill.files.length, id: skill.name, name: skill.name }
}

function failure(error: { code: string, message: string, fix?: string }, status: number): ServedSkillsError {
  return new ServedSkillsError(error.message, status, error.code, error.fix)
}

/** Every skill of `server/skills.ts` with its switch. Without `skillSettings()`, every skill is on. */
export async function listServedSkills(): Promise<ServedSkillSummary[]> {
  const value = await served()
  if (!isSkillSettings(value)) return (typeof value === "function" ? await value() : value).map(skill => summary(skill, true))
  const [error, states] = await value.list()
  if (error) throw failure(error, 503)
  return states.map(state => summary(state.skill, state.enabled))
}

/** Turns one skill on or off. */
export async function setServedSkill(name: string, enabled: boolean): Promise<ServedSkillSummary> {
  const value = await served()
  if (!isSkillSettings(value)) throw new ServedSkillsError("The skills of `server/skills.ts` have no switches.", 409, "SERVED_SKILLS_NO_SETTINGS", exportFix)
  const [error, state] = await value.set(name, enabled)
  if (error?.code === "SKILL_NOT_FOUND") throw new ServedSkillsError(error.message, 404, error.code, "Run `vitehub served-skills list` for the names of the skills.")
  if (error) throw failure(error, 503)
  return summary(state.skill, state.enabled)
}
