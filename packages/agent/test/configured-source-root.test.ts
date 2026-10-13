import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { transform } from "esbuild"
import { expect, it, vi } from "vitest"

import { getAgentLayerOptions, inheritAgentLayerOptions } from "../src/agent-layers.ts"
import { agentWithSkills, defineAgent, runAgent } from "../src/index.ts"
import { colocatedAgentSkillsSymbol, withColocatedAgentSkills } from "../src/internal/colocated-agent-skills.ts"
import { hubAgent } from "../src/vite.ts"
import { workspaceAgentWithSourceRoot, workspaceDefinitionFromOptions } from "../src/workspace-agent.ts"

function checkReconfiguredRoot(decorate: typeof workspaceAgentWithSourceRoot) {
  const preset = defineAgent({
    options: { customRoot: true },
    configure: options => defineAgent({
      driver: "codex",
      workspace: options.customRoot ? { sourceRootDir: "/configured" } : {},
    }),
  })
  const discovered = decorate(preset, "/discovered", "Repository instructions.")
  expect(getAgentLayerOptions(discovered)?.workspace).toHaveProperty("sourceRootDir", "/configured")

  const child = defineAgent({ extends: discovered, options: { customRoot: false } })
  expect(getAgentLayerOptions(child)?.workspace).toMatchObject({
    sourceRootDir: "/discovered",
    sources: { __vitehubAgentInstructions: { content: "Repository instructions." } },
  })
  expect(getAgentLayerOptions(discovered)?.workspace).toHaveProperty("sourceRootDir", "/configured")
}

it("restores the discovered source root when a configured runtime root is removed", () => {
  checkReconfiguredRoot(workspaceAgentWithSourceRoot)
})

it("restores the discovered source root through the generated deployment helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-configured-source-root-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), "export default defineAgent({ workspace: {} })")
    const plugin = hubAgent({ runtime: "deno" })
    if (typeof plugin.configResolved !== "function") throw new Error("Expected configResolved hook")
    // SAFETY: The generation hook only needs the fixture's project root here.
    await plugin.configResolved.call({} as never, { root } as never)

    const generated = await readFile(join(root, ".vitehub", "agent", "deno-server.ts"), "utf8")
    const helper = generated.match(/function withWorkspaceSourceRoot[\s\S]*?\n}/)?.[0]
    if (!helper) throw new Error("Expected generated Workspace source-root helper")
    const { code } = await transform(helper, { loader: "ts", format: "esm" })
    // SAFETY: Execute the generated helper with the same runtime dependencies as production.
    const decorate = new Function("inheritAgentLayerOptions", "workspaceDefinitionFromOptions", `${code}\nreturn withWorkspaceSourceRoot`)(
      inheritAgentLayerOptions,
      workspaceDefinitionFromOptions,
    ) as typeof workspaceAgentWithSourceRoot
    checkReconfiguredRoot(decorate)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("keeps runtime source-root decoration live before parent discovery", () => {
  const parent = defineAgent({ driver: "codex", workspace: {} })
  const child = workspaceAgentWithSourceRoot(defineAgent({ extends: parent }), "/child")
  const skills = { review: { content: "Review.", workspacePath: "skills/review/SKILL.md" } }
  withColocatedAgentSkills(parent, skills)
  expect(Reflect.get(child, colocatedAgentSkillsSymbol)).toEqual(skills)
  const manual = workspaceAgentWithSourceRoot(agentWithSkills(parent, { manual: "Manual." }), "/manual")
  withColocatedAgentSkills(manual, { local: skills.review })
  expect(Reflect.get(manual, colocatedAgentSkillsSymbol)).toMatchObject({
    review: skills.review, local: skills.review,
    "__vitehubAgentSkill:.agents/skills/manual/SKILL.md": { content: "Manual." },
  })
})

it("keeps generated colocated skills available to derived definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-generated-skills-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), "export default defineAgent({ workspace: {} })")
    const plugin = hubAgent({ runtime: "deno" })
    if (typeof plugin.configResolved !== "function") throw new Error("Expected configResolved hook")
    await plugin.configResolved.call({} as never, { root } as never)

    const generated = await readFile(join(root, ".vitehub", "agent", "deno-server.ts"), "utf8")
    const helper = generated.match(/function withWorkspaceSourceRoot[\s\S]*?\n}/)?.[0]
    if (!helper) throw new Error("Expected generated Workspace source-root helper")
    const { code } = await transform(helper, { loader: "ts", format: "esm" })
    const decorate = new Function("inheritAgentLayerOptions", "workspaceDefinitionFromOptions", `${code}\nreturn withWorkspaceSourceRoot`) (
      inheritAgentLayerOptions,
      workspaceDefinitionFromOptions,
    ) as (agent: object, sourceRootDir: string, colocatedInstructions?: string, colocatedSkills?: Record<string, {
      content: string
      encoding: "base64"
      materialize: "startup"
      mount: ""
      workspacePath: string
    }>) => object
    const base = defineAgent({ driver: "codex", workspace: {} })
    const encodedSkills = {
      review: {
        content: Buffer.from("Review.").toString("base64"),
        encoding: "base64" as const,
        materialize: "startup" as const,
        mount: "" as const,
        workspacePath: "skills/review/SKILL.md",
      },
    }
    const discovered = decorate(base, "/discovered", undefined, encodedSkills)
    const child = defineAgent({ extends: base, description: "Child" })

    expect(Object.getOwnPropertyDescriptor(discovered, colocatedAgentSkillsSymbol)?.value).toMatchObject({
      review: { content: new TextEncoder().encode("Review.") },
    })
    expect(Reflect.get(child, colocatedAgentSkillsSymbol)).toEqual(
      Object.getOwnPropertyDescriptor(discovered, colocatedAgentSkillsSymbol)?.value,
    )
    const discoveredChild = decorate(child, "/child", undefined, undefined)
    expect(Reflect.get(discoveredChild, colocatedAgentSkillsSymbol)).toEqual(Reflect.get(child, colocatedAgentSkillsSymbol))

    const lateParent = defineAgent({ driver: "codex", workspace: {} })
    const lateChild = defineAgent({ extends: lateParent })
    const decoratedLateChild = decorate(lateChild, "/late-child", undefined, undefined)
    decorate(lateParent, "/late-parent", undefined, encodedSkills)
    expect(Reflect.get(decoratedLateChild, colocatedAgentSkillsSymbol)).toMatchObject({
      review: { content: new TextEncoder().encode("Review.") },
    })

    const seen: unknown[] = []
    const runnable = defineAgent({ driver: { run: ({ context }) => { seen.push(context.get("agent.colocatedSkills")); return { text: "ok" } } } })
    const inheritedOnly = defineAgent({ extends: runnable })
    const discoveredInheritedOnly = decorate(inheritedOnly, "/child", undefined, undefined)
    decorate(runnable, "/parent", undefined, encodedSkills)
    await runAgent(discoveredInheritedOnly as typeof inheritedOnly, { runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() }, { prompt: "hello" })
    expect(seen).toEqual([Reflect.get(runnable, colocatedAgentSkillsSymbol)])
    expect(seen[0]).toMatchObject({ review: { content: new TextEncoder().encode("Review.") } })
    const manual = agentWithSkills(defineAgent({ driver: "codex", workspace: {} }), { manual: "Manual.", review: "Manual review." })
    const manualDiscovered = decorate(manual, "/manual", undefined, {
      ...encodedSkills,
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md": encodedSkills.review,
    })
    expect(Reflect.get(manualDiscovered, colocatedAgentSkillsSymbol)).toMatchObject({
      review: { content: new TextEncoder().encode("Review.") },
      "__vitehubAgentSkill:.agents/skills/manual/SKILL.md": { content: "Manual." },
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md": { content: "Manual review." },
    })
    expect(Reflect.get(manualDiscovered, "__vitehubWorkspaceAgentOptions").workspace.sources).toMatchObject({
      "__vitehubAgentSkill:.agents/skills/manual/SKILL.md": { content: "Manual." },
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md": { content: "Manual review." },
    })
    const cleared = decorate(base, "/discovered", undefined, undefined)
    expect(Object.getOwnPropertyDescriptor(cleared, colocatedAgentSkillsSymbol)).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(base, colocatedAgentSkillsSymbol)).toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
