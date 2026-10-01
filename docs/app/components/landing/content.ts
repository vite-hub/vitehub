export const installOptions = {
  skill: {
    label: "Agent skill",
    value: "skill",
    icon: "i-lucide-bot",
    command: "npx skills add https://vitehub.dev --skill vitehub",
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

export const agentStory = {
  path: "server/agents/review.ts",
  tutorialPath: "/docs/getting-started/first-agent",
  code: [
    'import { defineAgent } from "vite-hub/agent"',
    'import { browser } from "vite-hub/agent/capabilities"',
    'import { github } from "vite-hub/agent/channels"',
    "",
    "export default defineAgent({",
    '  description: "Reviews pull requests.",',
    "  channels: {",
    '    github: github({ pullRequest: { reconcile: { events: ["opened"] } } }),',
    "  },",
    '  driver: "codex",',
    '  workspace: { mode: "write" },',
    "  capabilities: [browser()],",
    "})",
  ],
  steps: [
    {
      id: "channel",
      label: "Channel",
      title: "A pull request opens",
      description: "Channels start an Invocation from GitHub, Slack, HTTP, or web chat.",
      lines: [2, 6, 7, 8],
      to: "/docs/agents/channels",
    },
    {
      id: "driver",
      label: "Driver",
      title: "Codex takes the run",
      description: "Use Codex, Claude Code, an AI SDK model, or your own function.",
      lines: [9],
      to: "/docs/agents/agent-drivers",
    },
    {
      id: "workspace",
      label: "Workspace",
      title: "It works in a real file tree",
      description: "A persistent Workspace holds the repository between runs.",
      lines: [10],
      to: "/docs/agents/workspace-context",
    },
    {
      id: "capabilities",
      label: "Capabilities",
      title: "You add the tools it needs",
      description: "Capabilities add tools such as the browser. Codex keeps its own tools.",
      lines: [1, 11],
      to: "/docs/capabilities",
    },
  ],
} as const;

// Ordered by importance to an Agent: what it works in and calls first, supporting primitives last.
// Realtime has only a reference page.
export const landingPrimitives = [
  {
    id: "workspace",
    name: "Workspace",
    description: "Persistent file trees",
    to: "/docs/server-primitives/workspace",
  },
  {
    id: "sandbox",
    name: "Sandbox",
    description: "Isolated execution",
    to: "/docs/server-primitives/sandbox",
  },
  {
    id: "connections",
    name: "Connections",
    description: "Connected account APIs",
    to: "/docs/server-primitives/connections",
  },
  {
    id: "workflow",
    name: "Workflow",
    description: "Durable orchestration",
    to: "/docs/server-primitives/workflows",
  },
  {
    id: "kv",
    name: "KV",
    description: "State and cache",
    to: "/docs/server-primitives/kv",
  },
  {
    id: "database",
    name: "Database",
    description: "Relational data",
    to: "/docs/server-primitives/database",
  },
  {
    id: "queue",
    name: "Queue",
    description: "Background jobs",
    to: "/docs/server-primitives/queue",
  },
  {
    id: "schedule",
    name: "Schedule",
    description: "Recurring work",
    to: "/docs/server-primitives/schedule",
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
    id: "browser",
    name: "Browser",
    description: "Browser operations",
    to: "/docs/server-primitives/browser",
  },
  {
    id: "shell",
    name: "Shell",
    description: "Command execution",
    to: "/docs/server-primitives/shell",
  },
  {
    id: "source",
    name: "Source",
    description: "Read-only content",
    to: "/docs/server-primitives/source",
  },
  {
    id: "content",
    name: "Content",
    description: "Parse and search",
    to: "/docs/server-primitives/content",
  },
  {
    id: "email",
    name: "Email",
    description: "Transactional email",
    to: "/docs/server-primitives/email",
  },
  {
    id: "env",
    name: "Env",
    description: "Typed configuration",
    to: "/docs/server-primitives/env",
  },
  {
    id: "rate-limit",
    name: "Rate Limit",
    description: "Request budgets",
    to: "/docs/server-primitives/rate-limit",
  },
  {
    id: "realtime",
    name: "Realtime",
    description: "Collaborative documents",
    to: "/docs/reference/realtime",
  },
] as const;
