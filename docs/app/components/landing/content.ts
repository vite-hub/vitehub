export const landingLanes = [
  {
    id: "server-primitives",
    number: "01",
    mode: "DIRECT",
    name: "Server Primitives",
    summary: "Add state, files, queues, schedules, sandboxes, and more to ordinary server code. Configure the active provider once and keep the application-facing import stable.",
    outcomes: [
      "Routes, jobs, and workers",
      "No Agent Definition required",
      "Provider support stays explicit",
    ],
    tutorialPath: "/docs/getting-started/first-server-primitive",
    docsPath: "/docs/server-primitives",
    action: "Run the Server Primitives tutorial",
    docsAction: "Explore every primitive",
    codeLabel: "src/server.ts",
    code: `import { kv } from '@vite-hub/kv'
import { H3 } from 'h3'

const app = new H3().put('/launch', async () => {
  await kv.set('launch', { ready: true })

  return kv.get('launch')
})

export default app`,
    proof: "The H3 app imports one stable Runtime Helper. The Vite Integration resolves the local or hosted KV driver.",
  },
  {
    id: "agents",
    number: "02",
    mode: "COMPOSED",
    name: "Agents",
    summary: "Define a named server actor, choose how it runs, then attach only the context and abilities it needs. Models, coding harnesses, and custom drivers share one boundary.",
    outcomes: [
      "Model, harness, or custom driver",
      "Inspectable Workspace and Capabilities",
      "Channels connect product surfaces",
    ],
    tutorialPath: "/docs/getting-started/first-agent",
    docsPath: "/docs/agents",
    action: "Run the Agent tutorial",
    docsAction: "Explore Agent Definitions",
    codeLabel: "server/agents/launch.ts",
    code: `import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    run: () => ({ text: 'Ready to work.' }),
  },
})`,
    proof: "This custom driver is deterministic and credential-free. Replace it with a model or coding harness when the product needs one.",
  },
] as const

export const serverPrimitives = [
  { name: "Auth", to: "/docs/server-primitives/auth" },
  { name: "Env", to: "/docs/server-primitives/env" },
  { name: "KV", to: "/docs/server-primitives/kv" },
  { name: "Database", to: "/docs/server-primitives/database" },
  { name: "Blob", to: "/docs/server-primitives/blob" },
  { name: "Workspace", to: "/docs/server-primitives/workspace" },
  { name: "Source", to: "/docs/server-primitives/source" },
  { name: "Queue", to: "/docs/server-primitives/queue" },
  { name: "Workflow", to: "/docs/server-primitives/workflows" },
  { name: "Schedule", to: "/docs/server-primitives/schedule" },
  { name: "Sandbox", to: "/docs/server-primitives/sandbox" },
  { name: "Shell", to: "/docs/server-primitives/shell" },
] as const

export const agentBoundaries = [
  {
    name: "Driver",
    description: "Chooses a model, coding harness, or custom run function.",
    to: "/docs/agents/agent-drivers",
  },
  {
    name: "Workspace",
    description: "Sets the file-tree boundary and mounted Sources for a run.",
    to: "/docs/agents/workspace-context",
  },
  {
    name: "Capabilities",
    description: "Grants named abilities instead of ambient access.",
    to: "/docs/capabilities",
  },
  {
    name: "Instructions",
    description: "Keeps behavior in composable, inspectable documents.",
    to: "/docs/agents/instructions",
  },
  {
    name: "Channels",
    description: "Connects the Agent to product surfaces and delivery paths.",
    to: "/docs/agents/channels",
  },
] as const
