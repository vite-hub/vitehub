import type { ServedSkillSummary } from "../../packages/vite-hub/src/skills/runtime.ts"
import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"

const skills: ServedSkillSummary[] = [
  { description: "Ship a release of this app. Use when someone asks to release, tag, or publish.", enabled: true, files: 3, id: "release", name: "release" },
  { description: "Hand work to the next agent with what changed, what is left, and how to check it.", enabled: true, files: 1, id: "handoff", name: "handoff" },
  { description: "Write a pull request body with before and after evidence.", enabled: false, files: 4, id: "pr-evidence", name: "pr-evidence" },
]

export function servedSkillsFixture(operation: string, input: Record<string, unknown>): ConsoleRpcResult | undefined {
  if (operation === "served-skills.list") return { ok: true, value: structuredClone(skills) }
  if (operation !== "served-skills.set") return undefined
  const skill = skills.find(entry => entry.name === input.name)
  if (!skill) return { code: "SKILL_NOT_FOUND", message: `No skill or skill file at skill://${String(input.name)}.`, ok: false, status: 404 }
  skill.enabled = input.enabled === true
  return { ok: true, value: structuredClone(skill) }
}
