import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { github } from "@vite-hub/workspace"
import { normalizeWorkspaceSourcesMetadata } from "@vite-hub/workspace/source-metadata"
import { afterEach, describe, expect, it } from "vitest"

import { codexDriver, defineAgent } from "../src/index.ts"
import { materializeProviderSkills, selectProviderSkills } from "../src/internal/provider-skills.ts"
import { sourceSkillMounts } from "../src/internal/source-skills.ts"
import { resolveWorkspaceSources } from "../../workspace/src/sources/resolution.ts"
import { createWorkspaceSourceView } from "../../workspace/src/sources/view.ts"
import { syncWorkspaceDefinition } from "../../workspace/src/lifecycle.ts"
import { materializeWorkspaceSources } from "../../workspace/src/sources/materialization.ts"
import { createLocalWorkspaceStore } from "../../workspace/src/storage/local.ts"

import type { WorkspaceDefinition, WorkspaceSource } from "../../workspace/src/core/types.ts"

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-source-skills-"))
  roots.push(root)
  return root
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

/** A repository Source like `github()`: `subset()` returns a Source that lists only the matching files. */
function repository(files: Record<string, string>, include?: readonly string[]): WorkspaceSource & { subsets: (readonly string[])[] } {
  const subsets: (readonly string[])[] = []
  const keys = Object.keys(files).filter(key => !include || include.some(pattern => key.startsWith(pattern.replace(/\*\*$/, ""))))
  return {
    subsets,
    async getKeys() {
      return keys
    },
    async getItem(key) {
      return { content: files[key], key }
    },
    subset(patterns) {
      subsets.push(patterns)
      return repository(files, patterns)
    },
  }
}

function sourceModes(sources: WorkspaceDefinition["sources"]) {
  return Object.fromEntries(normalizeWorkspaceSourcesMetadata(sources).map(source => [source.key, `${source.materialize} ${source.mountPath}`]))
}

describe("Source Skills", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  })

  it("fetches only the skill roots of a Source with materialize none", async () => {
    const portal = repository({
      ".agents/skills/customer-deploy/SKILL.md": "# Customer deploy\n",
      ".agents/skills/customer-deploy/references/steps.md": "Steps\n",
      ".codex/skills/codex/SKILL.md": "# Codex\n",
      ".claude/skills/claude/SKILL.md": "# Claude\n",
      "README.md": "# Portal\n",
      "app/page.vue": "<template />\n",
    })
    const agent = defineAgent({
      driver: codexDriver(),
      runtime: false,
      workspace: {
        materialize: "none",
        sources: {
          portal,
          docs: { source: repository({ "README.md": "# Docs\n" }), materialize: "startup" },
          private: { source: repository({ ".agents/skills/secret/SKILL.md": "# Secret\n" }), skills: false },
        },
      },
    })

    expect(sourceModes(agent.sources)).toEqual({
      "__vitehubSourceSkills:portal:.agents/skills": "startup portal/.agents/skills",
      "__vitehubSourceSkills:portal:.codex/skills": "startup portal/.codex/skills",
      "__vitehubSourceSkills:portal:.claude/skills": "startup portal/.claude/skills",
      docs: "startup docs",
      portal: "none portal",
      private: "none private",
    })
    expect(portal.subsets).toEqual([[".agents/skills/**", ".codex/skills/**", ".claude/skills/**"]])

    const store = createLocalWorkspaceStore(await tempRoot())
    const definition: WorkspaceDefinition = { name: "support", sources: agent.sources }
    await syncWorkspaceDefinition(definition, store)
    await materializeWorkspaceSources(definition, store)
    const paths = (await store.list("", { recursive: true })).filter(entry => entry.type === "file").map(entry => entry.path)
    expect(paths).toEqual(expect.arrayContaining([
      "portal/.agents/skills/customer-deploy/SKILL.md",
      "portal/.agents/skills/customer-deploy/references/steps.md",
      "portal/.codex/skills/codex/SKILL.md",
      "portal/.claude/skills/claude/SKILL.md",
    ]))
    const workspace = createWorkspaceSourceView(definition, store)
    await workspace.writeFile("portal/new.md", "New file")
    await workspace.mkdir("portal/new-directory")
    await expect(workspace.readFile("portal/.codex/skills/codex/SKILL.md")).resolves.toBe("# Codex\n")
    await expect(workspace.readFile("portal/.claude/skills/claude/SKILL.md")).resolves.toBe("# Claude\n")
    await workspace.rm("portal/new.md")
    await expect(workspace.writeFile("portal/.agents/skills/customer-deploy/SKILL.md", "Replacement")).rejects.toThrow("read-only")
    expect(paths).not.toContain("portal/README.md")
    expect(paths).not.toContain("private/.agents/skills/secret/SKILL.md")
  })

  it("narrows GitHub Sources and leaves model-backed Agents unchanged", () => {
    const sources = { portal: github({ auth: false, repo: "acme/portal" }) }
    const provider = defineAgent({ driver: codexDriver(), runtime: false, workspace: { materialize: "none", sources } })
    const derived = normalizeWorkspaceSourcesMetadata(provider.sources).find(source => source.key === "__vitehubSourceSkills:portal:.agents/skills")
    expect(derived?.source.fingerprint).toMatchObject({ root: ".agents/skills", source: { include: [".agents/skills/**", ".codex/skills/**", ".claude/skills/**"], repo: "acme/portal" } })

    const child = defineAgent({
      extends: provider,
      workspace: { materialize: "none", sources: { portal: github({ auth: false, repo: "acme/portal-fork" }) } },
    })
    const childDerived = normalizeWorkspaceSourcesMetadata(child.sources).find(source => source.key === "__vitehubSourceSkills:portal:.agents/skills")
    expect(childDerived?.source.fingerprint).toMatchObject({ source: { repo: "acme/portal-fork" } })

    const model = defineAgent({ driver: { run: () => "ok" }, runtime: false, workspace: { materialize: "none", sources } })
    expect(Object.keys(model.sources ?? {})).toEqual(["portal"])
  })

  it.each([false, true])("preserves the Skills opt-out through Source resolution (nested: %s)", async (nested) => {
    const root = await tempRoot()
    await writeFiles(root, { "portal/.agents/skills/hidden/SKILL.md": "# Hidden\n" })
    const dynamic: WorkspaceSource = {
      ...repository({}),
      resolve: async () => ({ ...repository({}), materialize: "startup" }),
    }
    const optedOut = { source: dynamic, skills: false as const }
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: { portal: nested ? { source: optedOut, mount: "portal" } : optedOut },
    }
    expect(sourceSkillMounts(definition.sources)).toEqual([])
    const resolved = await resolveWorkspaceSources(definition, {
      invocation: { context: {
        entries: () => new Map<string, unknown>().entries(),
        get: () => undefined,
        has: () => false,
        toJSON: () => ({}),
      } },
    })
    expect(sourceSkillMounts(resolved.sources)).toEqual([])
    const skills = await selectProviderSkills({
      cwd: root,
      provider: "codex",
      sources: sourceSkillMounts(resolved.sources),
      workspaceRoot: root,
    })
    expect(skills.has("hidden")).toBe(false)
  })

  it("gives the provider Source Skills after Agent Skills, in Source declaration order", async () => {
    const root = await tempRoot()
    await writeFiles(root, {
      "hidden/.agents/skills/hidden/SKILL.md": "# Hidden\n",
      "k8s/.claude/skills/k8s-environments/SKILL.md": "# k8s\n",
      "k8s/.claude/skills/shared/SKILL.md": "# k8s shared\n",
      "portal/.agents/skills/customer-deploy/SKILL.md": "# Customer deploy\n",
      "portal/.agents/skills/customer-deploy/references/steps.md": "Steps\n",
      "portal/.agents/skills/review/SKILL.md": "# Portal review\n",
      "portal/.agents/skills/shared/SKILL.md": "# Portal shared\n",
    })
    const skills = await selectProviderSkills({
      colocated: { review: { content: "# Agent review\n", workspacePath: ".agents/skills/review/SKILL.md" } },
      cwd: root,
      provider: "codex",
      sources: sourceSkillMounts({
        portal: github({ auth: false, repo: "acme/portal" }),
        k8s: github({ auth: false, repo: "acme/k8s" }),
        hidden: { source: github({ auth: false, repo: "acme/hidden" }), skills: false },
      }),
      workspaceRoot: root,
    })

    expect(skills.get("review")).toEqual({ files: new Map([["SKILL.md", "# Agent review\n"]]) })
    expect(skills.get("shared")).toEqual({ directory: join(root, "portal/.agents/skills/shared") })
    expect(skills.has("hidden")).toBe(false)
    expect(skills.get("k8s-environments")).toEqual({ directory: join(root, "k8s/.claude/skills/k8s-environments") })

    const directory = await materializeProviderSkills(skills, "codex", join(root, "provider-skills"))
    await expect(readFile(join(directory ?? "", "customer-deploy/references/steps.md"), "utf8")).resolves.toBe("Steps\n")
  })
})
