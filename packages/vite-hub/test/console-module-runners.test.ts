import { afterEach, expect, it, vi } from "vitest"

import type { AgentRuntimeContext } from "@vite-hub/agent"

// A development server runs server code in more than one Vite module runner, such as the `nitro` and `ssr`
// environments of one Nitro dev worker. Each runner loads its own copy of a module, and all of them share the global
// object. An Agent and the Console can load in different runners, so they must not keep their state in module scope.

async function moduleRunner<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules()
  return await load()
}

function runtime(runId: string): AgentRuntimeContext {
  return { memo: vi.fn(), run: { runId }, runtime: "unknown", waitUntil: vi.fn() }
}

afterEach(() => {
  for (const target of [globalThis, process]) {
    for (const key of Object.getOwnPropertySymbols(target)) {
      if (key.description?.startsWith("vitehub.console.") || key.description?.startsWith("vitehub.agent.invocations.")) {
        Reflect.deleteProperty(target, key)
      }
    }
  }
})

it("shows the sections that one module runner installs in the Console of another", async () => {
  const generated = await moduleRunner(() => import("../src/console/runtime/server/setup.ts"))
  const route = await moduleRunner(() => import("../src/console/runtime/server/sections.ts"))
  expect(route.installConsoleSections).not.toBe(generated.installConsoleSections)

  generated.installConsoleSections("/project", ["agents", "kv"])
  generated.installConsoleProjectName("/project", "app")

  expect(route.getConsoleSections()).toEqual(["agents", "kv"])
  expect(route.getConsoleProjectName()).toBe("app")
})

it("shows an Agent invocation from one module runner in the Console of another", async () => {
  const agentRunner = await moduleRunner(async () => ({
    agent: await import("../src/agent.ts"),
    journal: await import("@vite-hub/agent/invocations/app"),
    run: await import("@vite-hub/agent/server/internal"),
  }))
  const consoleRunner = await moduleRunner(async () => ({
    agents: await import("../src/console/runtime/server/agents.ts"),
    invocations: await import("../src/console/runtime/server/invocations.ts"),
    journal: await import("@vite-hub/agent/invocations/app"),
  }))
  expect(consoleRunner.journal).not.toBe(agentRunner.journal)

  // The generated server installs the app-wide journal before Agents run, and the Console runtime loads later.
  agentRunner.journal.installAgentInvocations({ default: "memory" })
  const agent = agentRunner.agent.defineAgent({ driver: { run: () => "from the Agent runner" }, runtime: false })
  consoleRunner.agents.installConsoleAgentDefinitions([{ definition: agent, fallbackName: "support" }], { projectRoot: "/project" })
  await agentRunner.run.runAgentWithContext(agent, runtime("cross-runner"), {})

  await expect(consoleRunner.invocations.getConsoleInvocations().list()).resolves.toMatchObject({
    invocations: [expect.objectContaining({ agentName: "support", status: "completed" })],
  })
})
