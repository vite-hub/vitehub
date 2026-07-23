export const installOptions = {
  skill: {
    label: "Agent skill",
    value: "skill",
    icon: "i-lucide-bot",
    command: "npx skills add https://vitehub.dev",
  },
  packages: [
    {
      label: "pnpm",
      value: "pnpm",
      icon: "i-simple-icons-pnpm",
      command: "pnpm add vite-hub h3 vite",
    },
    {
      label: "npm",
      value: "npm",
      icon: "i-simple-icons-npm",
      command: "npm install vite-hub h3 vite",
    },
    {
      label: "bun",
      value: "bun",
      icon: "i-simple-icons-bun",
      command: "bun add vite-hub h3 vite",
    },
    {
      label: "yarn",
      value: "yarn",
      icon: "i-simple-icons-yarn",
      command: "yarn add vite-hub h3 vite",
    },
  ],
} as const;

export const landingPaths = [
  {
    id: "agents",
    name: "Agents",
    description:
      "Define one inspectable server actor, choose how it runs, and attach only the context and abilities it needs.",
    tutorialPath: "/docs/getting-started/first-agent",
    action: "Build your first Agent",
    codeLabel: "server/agents/review.ts",
    code: `import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  description: "Reviews one repository change.",
  driver: {
    run({ prompt }) {
      return { text: "Reviewing " + String(prompt ?? "the repository") + "." }
    },
  },
})`,
  },
  {
    id: "server-primitives",
    name: "Server Primitives",
    description:
      "Use storage, queues, schedules, sandboxes, and more directly from ordinary server code.",
    tutorialPath: "/docs/getting-started/first-server-primitive",
    action: "Try a Server Primitive",
    codeLabel: "server/api/settings.put.ts",
    code: `import { kv } from "vite-hub/kv"

export default defineEventHandler(async (event) => {
  const [error] = await kv.set("settings", await readBody(event))
  if (error) throw error
  return { ok: true }
})`,
  },
] as const;

export const landingPrimitives = [
  {
    id: "workspace",
    name: "Workspace",
    description: "Persistent file trees",
    to: "/docs/server-primitives/workspace",
  },
  {
    id: "kv",
    name: "KV",
    description: "State and cache",
    to: "/docs/server-primitives/kv",
  },
  {
    id: "queue",
    name: "Queue",
    description: "Background jobs",
    to: "/docs/server-primitives/queue",
  },
  {
    id: "workflow",
    name: "Workflow",
    description: "Durable orchestration",
    to: "/docs/server-primitives/workflows",
  },
  {
    id: "schedule",
    name: "Schedule",
    description: "Recurring work",
    to: "/docs/server-primitives/schedule",
  },
  {
    id: "sandbox",
    name: "Sandbox",
    description: "Isolated execution",
    to: "/docs/server-primitives/sandbox",
  },
  {
    id: "database",
    name: "Database",
    description: "Relational data",
    to: "/docs/server-primitives/database",
  },
  {
    id: "blob",
    name: "Blob",
    description: "Files and uploads",
    to: "/docs/server-primitives/blob",
  },
  {
    id: "auth",
    name: "Auth",
    description: "Users and sessions",
    to: "/docs/server-primitives/auth",
  },
  {
    id: "env",
    name: "Env",
    description: "Typed configuration",
    to: "/docs/server-primitives/env",
  },
  {
    id: "source",
    name: "Source",
    description: "Read-only content",
    to: "/docs/server-primitives/source",
  },
  {
    id: "shell",
    name: "Shell",
    description: "Command execution",
    to: "/docs/server-primitives/shell",
  },
] as const;
