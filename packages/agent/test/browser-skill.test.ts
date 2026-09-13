import { describe, expect, it } from "vitest"
import { browserSkillContent, managedBrowserSkillContent } from "../src/internal/browser-skill.ts"

describe("retained browser skill availability", () => {
  it.each(["\n", "\r\n"])("aligns installed official metadata with a custom discovery path (%j)", (newline) => {
    const content = ["---", "name: agent-browser", "description: Official browser instructions", "---", "Run agent-browser.", ""].join(newline)
    const path = ".codex/skills/custom-browser/SKILL.md"
    const adapted = managedBrowserSkillContent(content, path)
    expect(adapted).toBe(content.replace("name: agent-browser", 'name: "custom-browser"'))
    const retained = browserSkillContent(adapted, path)
    expect(retained).toContain('name: "custom-browser"')
    expect(retained).toContain("Run agent-browser.")
    expect(retained).toContain("VITEHUB_BROWSER_ACTIVE")
  })

  it("adds discovery metadata to body-only custom instructions", () => {
    const retained = browserSkillContent("# My browser\nRun custom-browser.\n")
    expect(retained).toMatch(/^---\nname: "agent-browser"\ndescription: .+\n---\n/)
    expect(retained).toContain("# My browser\nRun custom-browser.\n")
    expect(retained.indexOf("## Browser availability")).toBeLessThan(retained.indexOf("# My browser"))
  })

  it("names synthesized metadata after the custom Skill directory", () => {
    const retained = browserSkillContent("# Browser\nUse custom-browser.\n", ".agents/skills/custom-browser/SKILL.md")
    expect(retained).toContain('name: "custom-browser"\n')
  })

  it.each([
    "Run custom-browser open https://example.com.\n",
    "---\nname: custom-browser\ndescription: Custom browser instructions\n---\nRun custom-browser.\n",
    "---\r\nname: custom-browser\r\n---\r\nRun custom-browser.\r\n",
  ])("guards custom instructions while preserving discovery metadata: %s", (content) => {
    const retained = browserSkillContent(content)
    expect(retained).toContain("check that `VITEHUB_BROWSER_ACTIVE` is `1`")
    expect(retained).toContain("do not run browser commands or installation steps")
    expect(retained.indexOf("## Browser availability")).toBeLessThan(retained.indexOf("Run custom-browser"))
    expect(retained).toContain(content.slice(content.indexOf("Run custom-browser")))
    if (content.startsWith("---")) expect(retained.startsWith(content.slice(0, content.lastIndexOf("---") + 3))).toBe(true)
  })
})
