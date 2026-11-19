import { defineErrors } from "@vite-hub/runtime"

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

// Keep published codes stable. Each code has a row in the Errors table of https://vitehub.dev/docs/console/skills.
const servedSkillsErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    SERVED_SKILLS_UNAVAILABLE: {
      why: "This runtime has no `server/skills.ts`.",
      fix: "Add `server/skills.ts` and build again.",
    },
    SERVED_SKILLS_INVALID_EXPORT: {
      why: "`server/skills.ts` exports no skills.",
      fix: "Default-export `skillSettings(skills, { store })` from `server/skills.ts`, or a skill list to only list them.",
    },
    SERVED_SKILLS_NO_SETTINGS: {
      why: "The skills of `server/skills.ts` have no switches.",
      fix: "Default-export `skillSettings(skills, { store })` from `server/skills.ts`, or a skill list to only list them.",
    },
  },
})

/** A catalog error with the HTTP status that the Console RPC and the CLI report. */
function withStatus<TError extends object>(error: TError, status: number): TError & { status: number } {
  return Object.assign(error, { status })
}

const registryKey: unique symbol = Symbol.for(servedSkillsRegistryKey)
const scope = globalThis as typeof globalThis & { [registryKey]?: () => Promise<Record<string, unknown>> }

/** The default export of `server/skills.ts`, or its `skills` export: switches, or a plain list that is always on. */
async function served(): Promise<SkillSettings | SkillList> {
  const load = scope[registryKey]
  if (!load) throw withStatus(servedSkillsErrors.SERVED_SKILLS_UNAVAILABLE(), 503)
  const module = await load()
  const value = Object.hasOwn(module, "default") ? module.default : module.skills
  if (isSkillSettings(value)) return value
  // SAFETY: A list function is only called, and an array is checked item by item below.
  if (typeof value === "function") return value as SkillList
  if (Array.isArray(value)) return value
  throw withStatus(servedSkillsErrors.SERVED_SKILLS_INVALID_EXPORT(), 500)
}

function summary(skill: Skill, enabled: boolean): ServedSkillSummary {
  return { description: skill.description, enabled, files: skill.files.length, id: skill.name, name: skill.name }
}

/** Every skill of `server/skills.ts` with its switch. Without `skillSettings()`, every skill is on. */
export async function listServedSkills(): Promise<ServedSkillSummary[]> {
  const value = await served()
  if (!isSkillSettings(value)) return (typeof value === "function" ? await value() : value).map(skill => summary(skill, true))
  const [error, states] = await value.list()
  if (error) throw withStatus(error, 503)
  return states.map(state => summary(state.skill, state.enabled))
}

/** Turns one skill on or off. */
export async function setServedSkill(name: string, enabled: boolean): Promise<ServedSkillSummary> {
  const value = await served()
  if (!isSkillSettings(value)) throw withStatus(servedSkillsErrors.SERVED_SKILLS_NO_SETTINGS(), 409)
  const [error, state] = await value.set(name, enabled)
  if (error) throw withStatus(error, error.code === "SKILL_NOT_FOUND" ? 404 : 503)
  return summary(state.skill, state.enabled)
}
