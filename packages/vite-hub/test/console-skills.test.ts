import { afterEach, describe, expect, it, vi } from "vitest"
import { agentWithSkills, defineAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { withColocatedAgentSkills } from "@vite-hub/agent/server/internal"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleInvocationFallback } from "../src/console/internal.ts"
import { requestConsole } from "../src/console/runtime/client/request.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

function install() {
  const base = withColocatedAgentSkills(defineAgent({ driver: "codex", runtime: false, workspace: {} }), {
    reference: { content: "# Evidence\n", workspacePath: ".agents/skills/review/references/evidence.md" },
    binary: { content: new Uint8Array([0xff, 0]), workspacePath: ".agents/skills/review/logo.png" },
    large: { content: "x".repeat(512 * 1024 + 1), workspacePath: ".agents/skills/review/large.txt" },
  })
  const definition = agentWithSkills(base, { review: "# Review\n\nRead the evidence.\n" })
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  installConsoleInvocationFallback(invocations, process.cwd())
  installConsoleAgentDefinitions([{ definition, fallbackName: "reviewer" }, { definition: defineAgent({ driver: "codex", runtime: false }), fallbackName: "empty" }], {
    invocations,
  })
}
function call(query: Record<string, string> = {}) {
  return handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
    method: "POST", headers: { [consoleRpcHeader]: "1", "content-type": "application/json" },
    body: JSON.stringify({ operation: "skills.inspect", input: query }),
  }))
}
afterEach(() => { vi.unstubAllGlobals(); installConsoleAccess({ mode: "open" }) })

describe("Console bundled Skills", () => {
  it("lists composed Skills and supporting files without returning content", async () => {
    install()
    const response = await call({ agent: "reviewer" })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ ok: true, value: { agent: "reviewer", agents: ["empty", "reviewer"], files: [
      { path: ".agents/skills/review/large.txt", size: 524289 },
      { path: ".agents/skills/review/logo.png", size: 2 },
      { path: ".agents/skills/review/references/evidence.md", size: 11 },
      { path: ".agents/skills/review/SKILL.md", size: 29 },
    ] } })
    expect(JSON.stringify(result)).not.toContain("Read the evidence")
  })
  it("reads the exact composed file through the browser RPC client while invocation is disabled", async () => {
    install()
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => handleConsoleRpcRequest(new Request(new URL(input, "http://vitehub.local"), init)))
    await expect(requestConsole("/api/_vitehub/console/skills", { query: { agent: "reviewer", path: ".agents/skills/review/SKILL.md" } })).resolves.toEqual({ path: ".agents/skills/review/SKILL.md", content: "# Review\n\nRead the evidence.\n", size: 29 })
  })
  it("opens the first Agent that bundles Skills when no Agent is chosen", async () => {
    install()
    expect(await (await call()).json()).toMatchObject({ ok: true, value: { agent: "reviewer", agents: ["empty", "reviewer"] } })
  })
  it("returns an honest empty catalog for an Agent without bundled Skills", async () => {
    install()
    expect(await (await call({ agent: "empty" })).json()).toMatchObject({ ok: true, value: { agent: "empty", files: [] } })
  })
  it.each(["../secret", "/etc/passwd", ".agents/skills/review/missing.md"])("cannot read an unbundled file: %s", async path => {
    install()
    expect((await call({ agent: "reviewer", path })).status).toBe(404)
  })
  it("rejects unknown Agents, oversized text, and binary previews", async () => {
    install()
    expect((await call({ agent: "unknown" })).status).toBe(404)
    expect((await call({ agent: "reviewer", path: ".agents/skills/review/large.txt" })).status).toBe(413)
    expect((await call({ agent: "reviewer", path: ".agents/skills/review/logo.png" })).status).toBe(415)
  })
  it("checks Console access before returning any files", async () => {
    install()
    installConsoleAccess({ mode: "open", authorize: () => false })
    const response = await call({ agent: "reviewer" })
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(".agents/skills")
  })
  it("does not expose Skills to a user limited to another Console section", async () => {
    install()
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["agents"] }) })
    const response = await call({ agent: "reviewer" })
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(".agents/skills")
  })
  it("allows read-only Skills access to inspect bundled files", async () => {
    install()
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["skills:read"] }) })
    const response = await call({ agent: "reviewer", path: ".agents/skills/review/SKILL.md" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, value: { content: "# Review\n\nRead the evidence.\n" } })
  })
})
