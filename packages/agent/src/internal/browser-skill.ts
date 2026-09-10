/** Retained browser instructions apply only while the capability is enabled. */
export function browserSkillContent(content: string): string {
  const guidance = "## Browser availability\n\nThis Skill persists between invocations. Before following any instructions below, check that `VITEHUB_BROWSER_ACTIVE` is `1`. Otherwise browser() is inactive for this invocation: do not run browser commands or installation steps from this Skill. Ask the caller to enable browser() for this Agent.\n\n"
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || ""
  return `${frontmatter}${frontmatter && !frontmatter.endsWith("\n") ? "\n" : ""}\n${guidance}${content.slice(frontmatter.length)}`
}
