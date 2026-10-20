import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { defineAgent } from "../src/index.ts"
import { agentWithSkills, colocatedAgentSkillsSymbol, decodeColocatedAgentSkills, withColocatedAgentSkills } from "../src/internal/colocated-agent-skills.ts"
import { readColocatedAgentSkills, resolveColocatedAgentSkillsRoot } from "../src/vite/colocated-agent-skills.ts"
import { workspaceAgentWithSourceRoot } from "../src/workspace-agent.ts"
import { syncWorkspaceDefinition } from "../../workspace/src/lifecycle.ts"
import { materializeWorkspaceSources } from "../../workspace/src/sources/materialization.ts"
import { createLocalWorkspaceStore } from "../../workspace/src/storage/local.ts"

import type { WorkspaceDefinition } from "../../workspace/src/core/types.ts"

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
      "__vitehubAgentSkill:.agents/skills/review/assets/fixture.bin",
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md",
    ])
    expect(sources?.["__vitehubAgentSkill:.agents/skills/review/assets/fixture.bin"]).toEqual({
      content: Buffer.from(binary).toString("base64"),
      encoding: "base64",
      materialize: "startup",
      mount: "",
      workspacePath: ".agents/skills/review/assets/fixture.bin",
    })
    expect(decodeColocatedAgentSkills(sources)?.["__vitehubAgentSkill:.agents/skills/review/assets/fixture.bin"]).toMatchObject({
      content: binary,
      workspacePath: ".agents/skills/review/assets/fixture.bin",
    })
  })

  it("attaches discovered sources without changing agents when no skills exist", () => {
    const agent: { name: string, settings?: string } = { name: "review" }
    Object.defineProperty(agent, "settings", { value: "preserved" })
    const sources = {
      review: { content: new TextEncoder().encode("# Review\n"), workspacePath: "skills/review/SKILL.md" },
    }

    expect(withColocatedAgentSkills(agent, undefined)).toBe(agent)
    const resolved = withColocatedAgentSkills(agent, sources)
    expect(Object.getOwnPropertyDescriptor(resolved, colocatedAgentSkillsSymbol)?.value).toBe(sources)
    expect(resolved.settings).toBe("preserved")
    expect(Object.getOwnPropertyDescriptor(resolved, "settings")?.enumerable).toBe(false)
  })

  it("keeps manual Skills when discovery adds, replaces, and removes local files", () => {
    const key = "__vitehubAgentSkill:.agents/skills/review/SKILL.md"
    const original = { name: "review" }
    const agent = agentWithSkills(original, { review: "Manual review." })
    const local = { content: "Local.", workspacePath: ".agents/skills/local/SKILL.md" }
    withColocatedAgentSkills(agent, { [key]: { ...local, content: "Discovered review." }, local })
    expect(Reflect.get(agent, colocatedAgentSkillsSymbol)).toMatchObject({
      [key]: { content: "Manual review." }, local,
    })
    withColocatedAgentSkills(agent, { replacement: local })
    expect(Reflect.get(agent, colocatedAgentSkillsSymbol)).toMatchObject({ [key]: { content: "Manual review." }, replacement: local })
    expect(Reflect.get(agent, colocatedAgentSkillsSymbol)).not.toHaveProperty("local")
    withColocatedAgentSkills(agent, undefined)
    expect(Object.keys(Reflect.get(agent, colocatedAgentSkillsSymbol))).toEqual([key])
    expect(Reflect.get(original, colocatedAgentSkillsSymbol)).toBeUndefined()
  })

  it("clears source metadata when a reused definition loses its skills", () => {
    const agent = { name: "review" }
    const sources = { review: { content: new TextEncoder().encode("# Review\n"), workspacePath: "skills/review/SKILL.md" } }
    const discovered = withColocatedAgentSkills(agent, sources)
    const cleared = withColocatedAgentSkills(agent, undefined)

    expect(Object.getOwnPropertyDescriptor(discovered, colocatedAgentSkillsSymbol)?.value).toBe(sources)
    expect(Object.getOwnPropertyDescriptor(agent, colocatedAgentSkillsSymbol)).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(cleared, colocatedAgentSkillsSymbol)).toBeUndefined()
  })

  it("only discovers skills owned by folder Agent Definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-skills-"))
    roots.push(root)
    await mkdir(join(root, "review", "skills", "review"), { recursive: true })
    await writeFile(join(root, "review.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "review", "skills", "review", "SKILL.md"), "# Review\n", "utf8")
    await writeFile(join(root, "review", "skills", "review", ".git"), "gitdir: /tmp/review-skill.git\n", "utf8")

    expect(readColocatedAgentSkills(join(root, "review.ts"))).toBeUndefined()
    expect(resolveColocatedAgentSkillsRoot(join(root, "review.ts"))).toBeUndefined()
    await writeFile(join(root, "review", "index.ts"), "export default {}\n", "utf8")
    expect(readColocatedAgentSkills(join(root, "review", "index.ts"))).toBeDefined()
    expect(resolveColocatedAgentSkillsRoot(join(root, "review", "index.ts"))).toBe(join(root, "review", "skills"))
  })

  it("preserves support for a symlinked Skills root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-skills-"))
    roots.push(root)
    await mkdir(join(root, "shared", "review"), { recursive: true })
    await writeFile(join(root, "agent.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "shared", "review", "SKILL.md"), "# Review\n", "utf8")
    await symlink("shared", join(root, "skills"))

    expect(readColocatedAgentSkills(join(root, "agent.ts"))).toHaveProperty(
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md",
    )
  })

  it.each([
    ["model", { model: {} as never }, true],
    ["provider", "codex" as const, false],
  ] as const)("stores bundled Skills and instructions in a %s Driver Workspace: %s", (_kind, driver, stored) => {
    const key = "__vitehubAgentSkill:.agents/skills/review/SKILL.md"
    const skill = { content: "# Review\n", materialize: "startup" as const, mount: "" as const, workspacePath: ".agents/skills/review/SKILL.md" }
    const userSource = { content: "# Notes\n", workspacePath: "notes.md" }
    const agent = withColocatedAgentSkills(defineAgent({ driver, runtime: false, workspace: { sources: { notes: userSource } } }), { [key]: skill })
    const resolved = workspaceAgentWithSourceRoot(agent, tmpdir(), "Support.\n") as { sources?: Record<string, unknown> }

    expect(resolved.sources?.notes).toEqual(userSource)
    expect(Object.hasOwn(resolved.sources ?? {}, key)).toBe(stored)
    expect(Object.hasOwn(resolved.sources ?? {}, "__vitehubAgentInstructions")).toBe(stored)
    expect(Reflect.get(resolved, colocatedAgentSkillsSymbol)).toEqual({ [key]: skill })
  })

  it("retires copies that an earlier release stored before a provider Driver stopped declaring them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-skills-retire-"))
    roots.push(root)
    const storeRoot = join(root, "store")
    const key = "__vitehubAgentSkill:.agents/skills/review/SKILL.md"
    const skill = { content: "# Review\n", materialize: "startup" as const, mount: "" as const, workspacePath: ".agents/skills/review/SKILL.md" }
    const earlier = {
      name: "support",
      sources: {
        [key]: skill,
        __vitehubAgentInstructions: { content: "Support.\n", materialize: "startup", mount: "", workspacePath: "AGENTS.md" },
        notes: { content: "# Notes\n", materialize: "startup", workspacePath: "notes.md" },
      },
    } as unknown as WorkspaceDefinition
    const earlierStore = createLocalWorkspaceStore(storeRoot)
    await syncWorkspaceDefinition(earlier, earlierStore)
    await materializeWorkspaceSources(earlier, earlierStore)
    await expect(earlierStore.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".agents/skills/review/SKILL.md" }),
      expect.objectContaining({ path: "AGENTS.md" }),
    ]))

    const agent = withColocatedAgentSkills(defineAgent({
      driver: "codex",
      runtime: false,
      workspace: { sources: { notes: { content: "# Notes\n", materialize: "startup", workspacePath: "notes.md" } } },
    }), { [key]: skill })
    const resolved = workspaceAgentWithSourceRoot(agent, root, "Support.\n") as { sources?: WorkspaceDefinition["sources"] }
    const current: WorkspaceDefinition = { name: "support", sources: resolved.sources }
    const currentStore = createLocalWorkspaceStore(storeRoot)
    await syncWorkspaceDefinition(current, currentStore)
    await materializeWorkspaceSources(current, currentStore)

    const paths = (await currentStore.list("", { recursive: true })).map(entry => entry.path)
    expect(paths).toContain("notes.md")
    expect(paths).not.toContain(".agents/skills/review/SKILL.md")
    expect(paths).not.toContain("AGENTS.md")
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
