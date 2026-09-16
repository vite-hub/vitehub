import { useWorkspace } from "@vite-hub/workspace"
import { resolveAgentCapabilities } from "../../src/capability-runtime.ts"
import { browser } from "../../src/capabilities/browser.ts"

const [root, skillContent] = process.argv.slice(2)
const path = ".agents/skills/agent-browser/SKILL.md"
const definition = { name: "browser-skill-restart", store: { provider: "local", root }, sources: {} }
const workspace = useWorkspace(definition.name, { definition, mode: "write" })
const resolved = await resolveAgentCapabilities({
  capabilities: [browser({ runtime: "external", skillContent })],
}, { runtime: "unknown", runtimeConfig: {}, memo() {}, waitUntil() {} }, {}, workspace, "write", {
  driverKind: "provider",
  invocationKind: "run",
  workspaceDefinition: definition,
})

try {
  console.log(JSON.stringify({
    content: await workspace.fs.readFile(path),
    ownership: (await workspace.fs.stat(path)).metadata?.capabilityWorkspaceContribution,
  }))
}
finally {
  await resolved.close()
}
