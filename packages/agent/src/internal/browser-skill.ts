import { skillPersistenceGuidance } from "./skill-persistence.ts"

/** Retained browser instructions apply only while the capability is enabled. */
export function browserSkillContent(content: string, skillPath = ".agents/skills/agent-browser/SKILL.md", persistent = true): string {
  const guidance = "## Browser availability\n\n" + skillPersistenceGuidance(persistent) + " Before following any instructions below, check that `VITEHUB_BROWSER_ACTIVE` is `1`. Otherwise browser() is inactive for this invocation: do not run browser commands or installation steps from this Skill. Ask the caller to enable browser() for this Agent.\n\n"
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || ""
  const name = skillPath.split("/").at(-2) || "agent-browser"
  const metadata = frontmatter || `---\nname: ${JSON.stringify(name)}\ndescription: Browser automation for website interaction, screenshots, extraction, and web app testing.\n---\n`
  return `${metadata}${!metadata.endsWith("\n") ? "\n" : ""}\n${guidance}${content.slice(frontmatter.length)}`
}
