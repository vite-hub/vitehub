import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { colocatedAgentSkillsSymbol, decodeColocatedAgentSkills, withColocatedAgentSkills } from "../src/internal/colocated-agent-skills.ts"
import { readColocatedAgentSkills } from "../src/vite/colocated-agent-skills.ts"

const roots: string[] = []

describe("colocated Agent Skills", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  it("recursively embeds files as binary-safe build sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-skills-"))
    roots.push(root)
    const handler = join(root, "agent.ts")
    const binary = Uint8Array.from([0, 255, 128, 13, 10, 42])
    await mkdir(join(root, "skills", "review", "assets"), { recursive: true })
    await writeFile(handler, "export default {}\n", "utf8")
    await writeFile(join(root, "skills", "review", "SKILL.md"), "# Review\n", "utf8")
    await writeFile(join(root, "skills", "review", "assets", "fixture.bin"), binary)

    const sources = readColocatedAgentSkills(handler)

    expect(Object.keys(sources || {})).toEqual([
      "__vitehubAgentSkill:skills/review/assets/fixture.bin",
      "__vitehubAgentSkill:skills/review/SKILL.md",
    ])
    expect(sources?.["__vitehubAgentSkill:skills/review/assets/fixture.bin"]).toEqual({
      content: Buffer.from(binary).toString("base64"),
      encoding: "base64",
      materialize: "build",
      mount: "",
      workspacePath: "skills/review/assets/fixture.bin",
    })
    expect(decodeColocatedAgentSkills(sources)?.["__vitehubAgentSkill:skills/review/assets/fixture.bin"]).toMatchObject({
      content: binary,
      workspacePath: "skills/review/assets/fixture.bin",
    })
  })

  it("attaches discovered sources without changing agents when no skills exist", () => {
    const agent = { name: "review" } as { name: string, settings?: string }
    Object.defineProperty(agent, "settings", { value: "preserved" })
    const sources = {
      review: { content: new TextEncoder().encode("# Review\n"), workspacePath: "skills/review/SKILL.md" },
    }

    expect(withColocatedAgentSkills(agent, undefined)).toBe(agent)
    const resolved = withColocatedAgentSkills(agent, sources)
    expect((resolved as Record<PropertyKey, unknown>)[colocatedAgentSkillsSymbol]).toBe(sources)
    expect(resolved.settings).toBe("preserved")
    expect(Object.getOwnPropertyDescriptor(resolved, "settings")?.enumerable).toBe(false)
  })

  it("only discovers skills owned by folder Agent Definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-skills-"))
    roots.push(root)
    await mkdir(join(root, "review", "skills", "review"), { recursive: true })
    await writeFile(join(root, "review.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "review", "skills", "review", "SKILL.md"), "# Review\n", "utf8")

    expect(readColocatedAgentSkills(join(root, "review.ts"))).toBeUndefined()
    await writeFile(join(root, "review", "index.ts"), "export default {}\n", "utf8")
    expect(readColocatedAgentSkills(join(root, "review", "index.ts"))).toBeDefined()
  })

  it("preserves support for a symlinked Skills root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-skills-"))
    roots.push(root)
    await mkdir(join(root, "shared", "review"), { recursive: true })
    await writeFile(join(root, "agent.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "shared", "review", "SKILL.md"), "# Review\n", "utf8")
    await symlink("shared", join(root, "skills"))

    expect(readColocatedAgentSkills(join(root, "agent.ts"))).toHaveProperty(
      "__vitehubAgentSkill:skills/review/SKILL.md",
    )
  })

  it("does not treat a sibling Agent named skills as Skills owned by a flat Agent named agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-skills-"))
    roots.push(root)
    const agentsRoot = join(root, "server", "agents")
    await mkdir(join(agentsRoot, "skills", "skills", "review"), { recursive: true })
    await writeFile(join(agentsRoot, "agent.ts"), "export default {}\n", "utf8")
    await writeFile(join(agentsRoot, "skills", "agent.ts"), "export default {}\n", "utf8")
    await writeFile(join(agentsRoot, "skills", "skills", "review", "SKILL.md"), "# Review\n", "utf8")

    expect(readColocatedAgentSkills(join(agentsRoot, "agent.ts"))).toBeUndefined()
    expect(readColocatedAgentSkills(join(agentsRoot, "skills", "agent.ts"))).toBeDefined()
  })
})
