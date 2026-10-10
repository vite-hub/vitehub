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
      to: "/docs/agents/capabilities",
    },
  ],
} as const;

// One KV store, read from a route and from an Agent. Both panes must use the same primitive.
export const sharedApi = {
  primitiveTo: "/docs/kv",
  capabilityTo: "/docs/kv/agent-capability",
  panes: [
    {
      id: "route",
      label: "Route",
      path: "server/api/notes.get.ts",
      caption: "Your route calls kv.get().",
      code: [
        'import { kv } from "vite-hub/kv"',
        "",
        "export default defineEventHandler(async () => {",
        '  const [error, notes] = await kv.get("notes")',
        "  if (error) throw error",
        "  return notes",
        "})",
      ],
    },
    {
      id: "agent",
      label: "Agent",
      path: "server/agents/support.ts",
      caption: "The Agent gets a kv_read tool for the same store.",
      code: [
        'import { defineAgent } from "vite-hub/agent"',
        'import { kv } from "vite-hub/agent/capabilities"',
        "",
        "export default defineAgent({",
        '  description: "Answers support questions.",',
        '  driver: "codex",',
        '  capabilities: [kv({ mode: "read" })],',
        "})",
      ],
    },
  ],
} as const;

export const nuxtHubMigration = {
  to: "/docs/getting-started/migrate-from-nuxthub",
  imports: [
    { from: "@nuxthub/kv", to: "vite-hub/kv" },
    { from: "@nuxthub/blob", to: "vite-hub/blob" },
    { from: "@nuxthub/db", to: "vite-hub/database/drizzle" },
  ],
} as const;

// Start with the primitives most Vite apps reach for. Agent stays in the catalog without taking over the page.
export const landingPrimitives = [
  {
    id: "kv",
    name: "KV",
    description: "State and cache",
    to: "/docs/kv",
  },
  {
    id: "blob",
    name: "Blob",
    description: "Files and uploads",
    to: "/docs/blob",
  },
  {
    id: "database",
    name: "Database",
    description: "Relational data",
    to: "/docs/database",
  },
  {
    id: "queue",
    name: "Queue",
    description: "Background jobs",
    to: "/docs/queue",
  },
  {
    id: "workflow",
    name: "Workflow",
    description: "Durable orchestration",
    to: "/docs/workflows",
  },
  {
    id: "schedule",
    name: "Schedule",
    description: "Recurring work",
    to: "/docs/schedule",
  },
  {
    id: "auth",
    name: "Auth",
    description: "Users and sessions",
    to: "/docs/auth",
  },
  {
    id: "connections",
    name: "Connections",
    description: "Connected account APIs",
    to: "/docs/connections",
  },
  {
    id: "workspace",
    name: "Workspace",
    description: "Persistent file trees",
    to: "/docs/workspace",
  },
  {
    id: "sandbox",
    name: "Sandbox",
    description: "Isolated execution",
    to: "/docs/sandbox",
  },
  {
    id: "browser",
    name: "Browser",
    description: "Browser operations",
    to: "/docs/browser",
  },
  {
    id: "shell",
    name: "Shell",
    description: "Command execution",
    to: "/docs/shell",
  },
  {
    id: "source",
    name: "Source",
    description: "Read-only content",
    to: "/docs/source",
  },
  {
    id: "content",
    name: "Content",
    description: "Parse and search",
    to: "/docs/content",
  },
  {
    id: "email",
    name: "Email",
    description: "Transactional email",
    to: "/docs/email",
  },
  {
    id: "channels",
    name: "Channels",
    description: "Named message delivery",
    to: "/docs/channels",
  },
  {
    id: "env",
    name: "Env",
    description: "Typed configuration",
    to: "/docs/env",
  },
  {
    id: "rate-limit",
    name: "Rate Limit",
    description: "Request budgets",
    to: "/docs/rate-limit",
  },
  {
    id: "realtime",
    name: "Realtime",
    description: "Collaborative documents",
    to: "/docs/realtime",
  },
  {
    id: "agent",
    name: "Agent",
    description: "Portable automation",
    to: "/docs/agents",
  },
  {
    id: "ui",
    name: "UI",
    description: "Agent interfaces",
    to: "/docs/ui",
  },
] as const;

export const portabilityExamples = [
  {
    id: "storage",
    label: "Store data",
    path: "server/api/notes.get.ts",
    description: "Read a value with the same KV helper on every supported host.",
    code: [
      'import { defineEventHandler } from "h3"',
      'import { kv } from "vite-hub/kv"',
      "",
      "export default defineEventHandler(async () => {",
      '  const [error, notes] = await kv.get("notes")',
      "  if (error) throw error",
      "  return notes",
      "})",
    ],
    hosts: [
      { name: "Cloudflare", icon: "i-simple-icons-cloudflare", provider: "Workers KV" },
      { name: "Vercel", icon: "i-simple-icons-vercel", provider: "Upstash Redis" },
      { name: "Deno", icon: "i-simple-icons-deno", provider: "Deno KV" },
      { name: "Node", icon: "i-simple-icons-nodedotjs", provider: "Local filesystem or Upstash" },
    ],
    to: "/docs/kv",
  },
  {
    id: "queue",
    label: "Queue work",
    path: "server/api/welcome.post.ts",
    description: "Send a job to Cloudflare or Vercel without importing their SDKs.",
    code: [
      'import { defineEventHandler, readBody } from "h3"',
      'import { runQueue } from "vite-hub/queue"',
      "",
      "export default defineEventHandler(async (event) => {",
      "  const payload = await readBody<{ email: string }>(event)",
      '  return runQueue("welcome-email", payload)',
      "})",
    ],
    hosts: [
      { name: "Cloudflare", icon: "i-simple-icons-cloudflare", provider: "Cloudflare Queues" },
      { name: "Vercel", icon: "i-simple-icons-vercel", provider: "Vercel Queues" },
    ],
    to: "/docs/queue",
  },
  {
    id: "schedule",
    label: "Run on a schedule",
    path: "server/schedules/daily-report.ts",
    description: "One definition becomes a native cron trigger where supported, or runs on a process runtime.",
    code: [
      'import { defineSchedule } from "vite-hub/schedule"',
      'import { sendDailyReport } from "../reports"',
      "",
      "export default defineSchedule({",
      '  cron: "0 9 * * *",',
      "  async handler({ scheduledAt }) {",
      "    await sendDailyReport(scheduledAt)",
      "  },",
      "})",
    ],
    hosts: [
      { name: "Cloudflare", icon: "i-simple-icons-cloudflare", provider: "Cron triggers" },
      { name: "Vercel", icon: "i-simple-icons-vercel", provider: "Cron Jobs" },
      { name: "Netlify", icon: "i-simple-icons-netlify", provider: "Scheduled functions" },
      { name: "Node", icon: "i-simple-icons-nodedotjs", provider: "Process runtime" },
    ],
    to: "/docs/schedule",
  },
] as const;
