import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { defineAgent } from "@vite-hub/agent"
import { agentWithColocatedSkills } from "@vite-hub/agent/runtime/workflow"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"

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
    await writeConsoleNitroPlugin(plugin, root, ["agents"], [{ name: "bot-dev", handler }], { agents: [], definitions: {} }, [], [], undefined, undefined, true)
    const generated = await readFile(plugin, "utf8")
    const install = vi.fn()
    const definition = defineAgent({ driver: "codex", runtime: false, workspace: {} })
    const execute = new Function("installConsoleSections", "installConsoleProjectName", "installConsoleAgentDefinitions", "agentWithColocatedSkills", "vitehubConsoleAgent0", generated.replace(/^import .+$/gm, "").replace("export default function", "function"))
    execute(() => {}, () => {}, install, agentWithColocatedSkills, { default: definition })
    const installed = install.mock.calls[0]?.[0]?.[0]?.definition
    expect(installed?.[Symbol.for("vitehub.agent.colocatedSkills")]).toMatchObject({
      "__vitehubAgentSkill:skills/review/SKILL.md": { content: new TextEncoder().encode("# Review\n"), workspacePath: "skills/review/SKILL.md" },
      "__vitehubAgentSkill:skills/review/references/evidence.md": { content: new TextEncoder().encode("Use the mounted evidence.\n"), workspacePath: "skills/review/references/evidence.md" },
    })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
