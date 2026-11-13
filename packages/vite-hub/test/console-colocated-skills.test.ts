import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it, vi } from "vitest"
import { codexDriver, defineAgent } from "@vite-hub/agent"
import { agentRuntimeModule } from "@vite-hub/agent/vite"
import { agentWithColocatedSkills } from "../../agent/dist/runtime/workflow.js"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { generatedModules } from "../src/internal/generated-modules.ts"

it("loads colocated Skills into the production Console definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-skills-"))
  try {
    const handler = join(root, "bot-dev", "agent.ts")
    await mkdir(join(root, "bot-dev"), { recursive: true })
    await mkdir(join(root, "bot", "skills", "review", "references"), { recursive: true })
    await writeFile(handler, "export default {}\n")
    await writeFile(join(root, "bot", "skills", "review", "SKILL.md"), "# Review\n")
    await writeFile(join(root, "bot", "skills", "review", "references", "evidence.md"), "Use the mounted evidence.\n")
    await symlink("../bot/skills", join(root, "bot-dev", "skills"))
    const plugin = join(root, "plugin.mjs")
    await writeConsoleNitroPlugin({ file: plugin, projectRoot: root, sections: ["agents"], catalog: { agents: [{ name: "bot-dev", handler }], content: {} }, blobStores: [], invoke: true })
    const generated = await readFile(plugin, "utf8")
    const agentUrl = pathToFileURL(handler).href
    const skillsImport = agentRuntimeModule("runtime/workflow")
    // The Agent Definition and the Agent runtime load with the Console runtime, not when the server starts.
    expect(generated).not.toMatch(/^import .*agent\.ts/m)
    expect(generated).not.toContain(`from ${JSON.stringify(skillsImport)}`)
    expect(generated).toContain(`import(${JSON.stringify(agentUrl)})`)
    expect(generated).toContain(`import(${JSON.stringify(skillsImport)})`)
    const skillsRuntime = await import(skillsImport)
    expect(skillsRuntime.agentWithColocatedSkills).toBeTypeOf("function")
    const install = vi.fn()
    const definition = defineAgent({ driver: codexDriver(), runtime: false, workspace: {} })
    const source = generated
      .replace(/^import .+$/gm, "")
      .replace(`import(${JSON.stringify(generatedModules.consoleOperations)})`, "Promise.resolve({ installConsoleOperations: installOperations })")
      .replace(`import("vite-hub/console/server")`, "Promise.resolve({ installConsoleAgentDefinitions: installAgents })")
      .replace(`import(${JSON.stringify(skillsImport)})`, "Promise.resolve({ agentWithColocatedSkills: withSkills })")
      .replace(`import(${JSON.stringify(agentUrl)})`, "Promise.resolve(agentModule)")
      .replace("export default function", "function")
    const execute = new Function("installConsoleSections", "installOperations", "installConsoleRuntime", "installConsoleProjectName", "installConsoleBuild", "installConsoleDevelopment", "installAgents", "withSkills", "agentModule", "installConsoleClient", source)
    const installOperations = vi.fn()
    let loadRuntime: (() => Promise<() => void>) | undefined
    execute(() => {}, installOperations, (load: () => Promise<() => void>) => { loadRuntime = load }, () => {}, () => {}, () => {}, install, agentWithColocatedSkills, { default: definition }, () => {})
    expect(installOperations).not.toHaveBeenCalled()
    const installRuntime = await loadRuntime?.()
    expect(installOperations).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    installRuntime?.()
    expect(installOperations).toHaveBeenCalledWith([], { invoke: true })
    expect(install).toHaveBeenCalledWith([expect.objectContaining({ fallbackName: "bot-dev" })], expect.objectContaining({ invoke: true, projectRoot: root }))
    const installed = install.mock.calls[0]?.[0]?.[0]?.definition
    expect(installed?.[Symbol.for("vitehub.agent.colocatedSkills")]).toMatchObject({
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md": { content: new TextEncoder().encode("# Review\n"), materialize: "startup", workspacePath: ".agents/skills/review/SKILL.md" },
      "__vitehubAgentSkill:.agents/skills/review/references/evidence.md": { content: new TextEncoder().encode("Use the mounted evidence.\n"), materialize: "startup", workspacePath: ".agents/skills/review/references/evidence.md" },
    })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
