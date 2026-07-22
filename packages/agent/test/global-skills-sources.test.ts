import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { defineWorkspace, glob, useWorkspace, type WorkspaceSourceInput } from "@vite-hub/workspace"
import { registerWorkspace } from "@vite-hub/workspace/test"
import { skills } from "../src/capabilities.ts"

const globalSkillsSymbol = Symbol.for("vitehub.agent.globalSkills")
const tempRoots: string[] = []

interface GlobalSkillBinding {
  path: string
  source: WorkspaceSourceInput
  sourceKey: string
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-global-skills-"))
  tempRoots.push(root)
  return root
}

function globalSkillBinding(source: WorkspaceSourceInput): GlobalSkillBinding {
  const capability = skills({ path: "skills/review", scope: "global", source })
  return (capability as unknown as Record<PropertyKey, GlobalSkillBinding>)[globalSkillsSymbol]!
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("global Skill Sources", () => {
  it("mounts a root-confined directory Source through a real Workspace read", async () => {
    const root = await createRoot()
    await mkdir(join(root, "review", "references"), { recursive: true })
    await writeFile(join(root, "review", "SKILL.md"), "# Review\n")
    await writeFile(join(root, "review", "references", "rules.md"), "# Rules\n")
    const skill = globalSkillBinding(glob({ cwd: "review", include: "**/*" }))
    const workspaceName = `global-skill-directory-${basename(root)}`
    registerWorkspace(workspaceName, defineWorkspace({
      sourceRootDir: root,
      sources: { [skill.sourceKey]: skill.source },
      store: { provider: "memory" },
    }))
    const workspace = useWorkspace(workspaceName, { mode: "read" })

    await expect(workspace.fs.readFile(`${skill.path}/SKILL.md`)).resolves.toBe("# Review\n")
    await expect(workspace.fs.readFile(`${skill.path}/references/rules.md`)).resolves.toBe("# Rules\n")
  })

  it("keeps a root-relative File Source with an explicit Workspace path single-file", async () => {
    const root = await createRoot()
    await mkdir(join(root, "review"), { recursive: true })
    await writeFile(join(root, "review", "SKILL.md"), "# Review\n")
    const skill = globalSkillBinding({ path: "review/SKILL.md", workspacePath: "SKILL.md" })
    const workspaceName = `global-skill-file-${basename(root)}`
    registerWorkspace(workspaceName, defineWorkspace({
      sourceRootDir: root,
      sources: { [skill.sourceKey]: skill.source },
      store: { provider: "memory" },
    }))
    const workspace = useWorkspace(workspaceName, { mode: "read" })

    await expect(workspace.fs.readFile(`${skill.path}/SKILL.md`)).resolves.toBe("# Review\n")
    await expect(workspace.fs.list(skill.path, { recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: `${skill.path}/SKILL.md`, type: "file" }),
    ])
  })

  it("rejects an absolute File Source even when it points at a real Skill directory", async () => {
    const root = await createRoot()
    await writeFile(join(root, "SKILL.md"), "# Review\n")

    expect(() => globalSkillBinding({ path: root })).toThrow("File Sources are single-file and root-confined")
  })

  it("rejects a nested absolute File Source with an explicit Workspace path", async () => {
    const root = await createRoot()
    const path = join(root, "SKILL.md")
    await writeFile(path, "# Review\n")

    expect(() => globalSkillBinding({
      mount: "",
      source: { path, workspacePath: "SKILL.md" },
    })).toThrow("File Sources are single-file and root-confined")
  })

  it("rejects cyclic Source bindings", () => {
    const source = {} as Record<string, unknown>
    source.source = source

    expect(() => globalSkillBinding(source as unknown as WorkspaceSourceInput)).toThrow("cannot use a cyclic Source binding")
  })
})
