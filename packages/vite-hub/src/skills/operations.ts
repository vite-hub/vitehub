import { defineOperation, table } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { ServedSkillSummary } from "./runtime.ts"

// The runtime module reaches `server/skills.ts` through the generated Nitro plugin. The operations load it when they
// run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime.ts")

function defineServedSkillsOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // Access to the Served skills section of the Console decides. The operations never read the signed-in user.
  return defineOperation({ ...definition, section: "served-skills", user: false })
}

function formatList(skills: ServedSkillSummary[]): string {
  if (!skills.length) return "No served skills.\n"
  return `${table([["NAME", "STATE", "FILES"], ...skills.map(skill => [skill.name, skill.enabled ? "on" : "off", String(skill.files)])])}\n`
}

const list = defineServedSkillsOperation<Record<string, never>, ServedSkillSummary[]>({
  cli: { default: true, format: formatList },
  description: "List the Agent Skills that server/skills.ts serves to coding agents, and whether each one is on.",
  input: v.strictObject({}),
  kind: "read",
  name: "served-skills.list",
  run: async () => (await runtime()).listServedSkills(),
})

const set = defineServedSkillsOperation<{ name: string, enabled: boolean }, ServedSkillSummary>({
  cli: { positional: ["name", "enabled"], format: skill => `${skill.name} is ${skill.enabled ? "on" : "off"}.\n` },
  description: "Turn one served Agent Skill on or off for every server instance, without a deploy.",
  input: v.strictObject({ name: v.pipe(v.string(), v.minLength(1)), enabled: v.boolean() }),
  kind: "write",
  name: "served-skills.set",
  run: async ({ name, enabled }) => (await runtime()).setServedSkill(name, enabled),
})

/** The `served-skills.*` operations: list and set. The Console, `vitehub served-skills`, and agents run them. */
export const servedSkillsOperations: readonly AnyOperation[] = [list, set]

export type { ServedSkillSummary }
