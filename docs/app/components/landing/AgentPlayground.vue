<script setup lang="ts">
import PropertyHelp from "./PropertyHelp.vue"
import highlighter from "#mdc-highlighter"

type HastNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
  value?: string
}

type ProjectFile = {
  path: string
  label: string
  content: string
}

type ExampleProject = {
  id: string
  name: string
  rootPath: string
  files: ProjectFile[]
}

type AgentPropertyKey = "driver" | "runtime" | "box" | "workspace" | "capabilities" | "channels"

type PlaygroundOption = {
  code: string
  icon: string
  key: string
  label: string
}

type AgentConfig = {
  defaultPropertyKeys: AgentPropertyKey[]
  visiblePropertyKeys: AgentPropertyKey[]
  driverKey: string
  runtimeKey: string
  boxKey: string
  workspaceKey: string
  capabilityKeys: string[]
  channelKeys: string[]
}

type EnvironmentOption = {
  color: string
  icon: string
  key: string
  label: string
}

const projects: ExampleProject[] = [
  {
    id: "reviewer",
    name: "Pull request reviewer",
    rootPath: "server/agents/review",
    files: [
      {
        path: "server/agents/review/agent.ts",
        label: "agent.ts",
        content: `import { defineAgent } from "@vite-hub/agent"
import { github } from "@vite-hub/agent/channels"
import {
  browser,
  repositoryHost,
  skills,
} from "@vite-hub/agent/capabilities"

export default defineAgent({
  driver: "codex",
  workspace: {
    name: "repository",
    mode: "write",
  },
  channels: {
    github: github({ pullRequest: true }),
  },
  capabilities: [
    browser(),
    repositoryHost({ mode: "read" }),
    skills({ path: "./skills" }),
  ],
})`,
      },
      {
        path: "server/agents/review/instructions.md",
        label: "instructions.md",
        content: `# Pull request reviewer

Review the change as a maintainer of this repository.

- Read the surrounding code before judging the diff.
- Reproduce UI changes in the browser and save evidence.
- Reconcile checks, comments, and the current pull request head.
- Report only findings that change the outcome.
- Explain the mechanism and the user impact.
- Never post a review without explicit approval.`,
      },
      {
        path: "server/agents/review/skills/review/SKILL.md",
        label: "SKILL.md",
        content: `---
name: review
description: Review one pull request end to end.
---

# Review pull request

1. Reconcile the branch, base, and unresolved comments.
2. Read the diff in the context of the owning modules.
3. Reproduce high-confidence findings locally and in the browser.
4. Inspect repository checks and review state.
5. Return a concise review with exact file references and evidence.`,
      },
    ],
  },
  {
    id: "nuxt",
    name: "Nuxt Agent",
    rootPath: "server/agents/nuxt",
    files: [
      {
        path: "server/agents/nuxt/agent.ts",
        label: "agent.ts",
        content: `import { defineAgent } from "@vite-hub/agent"
import {
  mcp,
  rateLimit,
  skills,
} from "@vite-hub/agent/capabilities"
import { remoteMcpServer } from "@vite-hub/agent/mcp"
import { createRateLimiter } from "@vite-hub/rate-limit"
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"

const messages = createRateLimiter({
  driver: memoryRateLimitDriver(),
  limit: 20,
  name: "nuxt-docs-messages",
  window: "1d",
})

export default defineAgent({
  driver: "codex",
  capabilities: [
    rateLimit({ limiter: messages }),
    mcp({
      servers: {
        nuxt: remoteMcpServer({
          url: "https://nuxt.com/mcp",
        }),
      },
    }),
    skills({ path: "./skills" }),
  ],
})`,
      },
      {
        path: "server/agents/nuxt/instructions.md",
        label: "instructions.md",
        content: `# Nuxt Agent

Answer questions from Nuxt's official documentation and ecosystem.

- Call the Nuxt MCP tool for the exact documentation path.
- Request only the sections needed for the answer.
- Resolve module names through the modules catalog.
- Link every claim to the Nuxt page you inspected.
- Be concise and honest when the docs do not settle the question.`,
      },
      {
        path: "server/agents/nuxt/skills/docs/SKILL.md",
        label: "SKILL.md",
        content: `---
name: nuxt-docs
description: Answer one Nuxt question from official sources.
---

# Talk to Nuxt docs

1. Route the question to the matching Nuxt MCP tool.
2. Fetch the exact page or relevant sections.
3. Distinguish documented behavior from inference.
4. Answer with direct links to the sources used.`,
      },
    ],
  },
  {
    id: "status",
    name: "Research Agent",
    rootPath: "server/agents/research",
    files: [
      {
        path: "server/agents/research/agent.ts",
        label: "agent.ts",
        content: `import { defineAgent, workflow } from "@vite-hub/agent"
import { webChat } from "@vite-hub/agent/channels"
import {
  browser,
  memory,
  skills,
  webSearch,
  workspaceJsonlMemoryStore,
} from "@vite-hub/agent/capabilities"

export default defineAgent({
  driver: "claude-code",
  runtime: workflow("agent"),
  workspace: {
    name: "research",
    mode: "write",
  },
  channels: {
    web: webChat(),
  },
  capabilities: [
    webSearch({ mode: "tool" }),
    browser(),
    memory({
      stores: {
        research: {
          adapter: workspaceJsonlMemoryStore(),
          scope: { agent: "research" },
        },
      },
    }),
    skills({ path: "./skills" }),
  ],
})`,
      },
      {
        path: "server/agents/research/instructions.md",
        label: "instructions.md",
        content: `# Research Agent

Investigate one question deeply enough to support a decision.

- Start by identifying the decision and the evidence it requires.
- Search broadly, then open primary sources in the browser.
- Cross-check conflicting claims and account for publication dates.
- Save durable findings and known dead ends to research memory.
- Return a concise answer with source links and explicit uncertainty.`,
      },
      {
        path: "server/agents/research/skills/research/SKILL.md",
        label: "SKILL.md",
        content: `---
name: source-research
description: Investigate one question using current primary sources.
---

# Research with evidence

1. Turn the request into answerable research questions.
2. Search for current primary sources and open the strongest candidates.
3. Compare claims, dates, methods, and conflicts across sources.
4. Save reusable findings and rejected paths to memory.
5. Deliver the answer with direct links and calibrated confidence.`,
      },
    ],
  },
]

const agentProperties: Record<AgentPropertyKey, {
  description: string
  icon: string
  label: string
  title: string
  to: string
}> = {
  driver: {
    description: "Chooses how each invocation runs: through a coding harness, a model, or your own function.",
    icon: "i-lucide-bot",
    label: "driver",
    title: "Agent Driver",
    to: "/docs/agents/agent-drivers/",
  },
  runtime: {
    description: "Chooses inline execution or a durable workflow that can survive waits, retries, and restarts.",
    icon: "i-lucide-workflow",
    label: "runtime",
    title: "Execution runtime",
    to: "/docs/server-primitives/workflows/",
  },
  box: {
    description: "Prepares the harness process environment, private Home, and execution boundary on a trusted host or Crabbox.",
    icon: "i-lucide-package-open",
    label: "box",
    title: "Execution box",
    to: "/docs/agents/boxes/",
  },
  workspace: {
    description: "Provides the persistent file tree and selects where the Agent's working state is stored.",
    icon: "i-lucide-folder-tree",
    label: "workspace",
    title: "Workspace",
    to: "/docs/agents/workspace-context/",
  },
  capabilities: {
    description: "Adds named abilities such as browser, Git, scheduling, and Skills.",
    icon: "i-lucide-blocks",
    label: "capabilities",
    title: "Capabilities",
    to: "/docs/capabilities/official-capabilities/",
  },
  channels: {
    description: "Connects the Agent to triggers and delivery surfaces such as GitHub, Slack, and HTTP.",
    icon: "i-lucide-radio-tower",
    label: "channels",
    title: "Channels",
    to: "/docs/agents/channels/",
  },
}
const agentPropertyOrder = Object.keys(agentProperties) as AgentPropertyKey[]

const driverOptions = [
  { code: '"codex"', icon: "i-simple-icons-openai", key: "codex", label: "Codex harness" },
  { code: "{ kind: 'claude-code', sandbox: false }", icon: "i-simple-icons-anthropic", key: "claude", label: "Claude Code harness" },
  { code: "{ model: gateway('openai/gpt-5.1-mini') }", icon: "i-simple-icons-vercel", key: "model", label: "Bare model" },
  { code: "{ run: customAgent }", icon: "i-lucide-braces", key: "custom", label: "Custom runner" },
] satisfies PlaygroundOption[]

const runtimeOptions = [
  { code: "workflow('agent')", icon: "i-lucide-workflow", key: "workflow", label: "Durable workflow" },
  { code: "false", icon: "i-lucide-zap", key: "inline", label: "Inline execution" },
] satisfies PlaygroundOption[]

const boxOptions = [
  { code: "{ runtime: 'trusted-host' }", icon: "i-lucide-server-cog", key: "trusted", label: "Trusted host" },
] satisfies PlaygroundOption[]

const workspaceOptions = [
  { code: "{ name: 'repository', mode: 'write' }", icon: "i-simple-icons-github", key: "github", label: "GitHub repository" },
  { code: "{ name: 'artifacts', mode: 'write' }", icon: "i-simple-icons-cloudflare", key: "cloudflare", label: "Cloudflare Artifacts" },
  { code: "{ name: 'project', mode: 'write' }", icon: "i-simple-icons-vercel", key: "vercel", label: "Vercel Blob" },
  { code: "{ name: 'local', mode: 'write' }", icon: "i-lucide-hard-drive", key: "local", label: "Local workspace" },
] satisfies PlaygroundOption[]

const capabilityOptions = [
  { code: "access({ workspace })", icon: "i-lucide-shield-check", key: "access", label: "Access" },
  { code: "chat()", icon: "i-lucide-messages-square", key: "chat", label: "Chat" },
  { code: "inputCommands({ commands })", icon: "i-lucide-command", key: "input-commands", label: "Input commands" },
  { code: "subagents({ agents })", icon: "i-lucide-git-fork", key: "subagents", label: "Subagents" },
  { code: "browser()", icon: "i-lucide-monitor", key: "browser", label: "Browser" },
  { code: "workspaceShell({ mode: 'write' })", icon: "i-lucide-square-terminal", key: "workspace-shell", label: "Workspace shell" },
  { code: "git()", icon: "i-lucide-git-branch", key: "git", label: "Git" },
  { code: "skills({ path: './skills' })", icon: "i-lucide-scroll-text", key: "skills", label: "Skills" },
  { code: "memory({ stores })", icon: "i-lucide-brain", key: "memory", label: "Memory" },
  { code: "kv()", icon: "i-lucide-database-zap", key: "kv", label: "KV storage" },
  { code: "blob()", icon: "i-lucide-package", key: "blob", label: "Blob storage" },
  { code: "db()", icon: "i-lucide-database", key: "db", label: "Database" },
  { code: "email({ from, recipients })", icon: "i-lucide-mail", key: "email", label: "Email" },
  { code: "sandbox({ commands })", icon: "i-lucide-box", key: "sandbox", label: "Sandbox" },
  { code: "schedule({ mode: 'write', allowSelfTarget: true })", icon: "i-lucide-calendar-clock", key: "schedule", label: "Schedules" },
  { code: "repositoryHost({ mode: 'read' })", icon: "i-lucide-git-pull-request", key: "repository", label: "Repository host" },
  { code: "repositoryHostContext()", icon: "i-lucide-git-pull-request-arrow", key: "repository-context", label: "Repository host context" },
  { code: "mcp({ servers: { nuxt } })", icon: "i-lucide-plug-zap", key: "mcp", label: "MCP servers" },
  { code: "webSearch({ mode: 'tool' })", icon: "i-lucide-search", key: "web-search", label: "Web search" },
  { code: "fetch({ tools })", icon: "i-lucide-globe", key: "fetch", label: "Fetch tools" },
  { code: "openapi({ spec, operations })", icon: "i-lucide-braces", key: "openapi", label: "OpenAPI tools" },
  { code: "transcribe({ model: transcriptionModel })", icon: "i-lucide-audio-lines", key: "transcribe", label: "Transcription" },
  { code: "llmRoute({ choices, model: decisionModel })", icon: "i-lucide-route", key: "llm-route", label: "LLM routing" },
  { code: "llmGate({ allow, reject, model: decisionModel })", icon: "i-lucide-shield", key: "llm-gate", label: "LLM gate" },
  { code: "rateLimit({ limiter: messages })", icon: "i-lucide-gauge", key: "rate-limit", label: "Rate limit" },
  { code: "title()", icon: "i-lucide-heading", key: "title", label: "Title" },
  { code: "chatSummary()", icon: "i-lucide-message-square-text", key: "chat-summary", label: "Chat summary" },
  { code: "progressSummary()", icon: "i-lucide-list-collapse", key: "progress-summary", label: "Progress summary" },
  { code: "papercuts({ report })", icon: "i-lucide-bug", key: "papercuts", label: "Papercut reports" },
  { code: "usageCost()", icon: "i-lucide-receipt", key: "usage-cost", label: "Usage cost" },
] satisfies PlaygroundOption[]

const channelOptions = [
  { code: "discord: discord()", icon: "i-simple-icons-discord", key: "discord", label: "Discord" },
  { code: "github: github({ pullRequest: true })", icon: "i-simple-icons-github", key: "github", label: "GitHub" },
  { code: "http: http()", icon: "i-lucide-webhook", key: "http", label: "HTTP" },
  { code: "slack: slack()", icon: "i-simple-icons-slack", key: "slack", label: "Slack" },
  { code: "teams: teams()", icon: "i-simple-icons-microsoftteams", key: "teams", label: "Microsoft Teams" },
  { code: "telegram: telegram()", icon: "i-simple-icons-telegram", key: "telegram", label: "Telegram" },
  { code: "web: webChat()", icon: "i-lucide-message-circle", key: "web-chat", label: "Web chat" },
] satisfies PlaygroundOption[]

const frameworkOptions: EnvironmentOption[] = [
  { color: "#646cff", icon: "i-simple-icons-vite", key: "vite", label: "Vite" },
  { color: "#00dc82", icon: "i-simple-icons-nuxt", key: "nuxt", label: "Nuxt" },
  { color: "#f27cec", icon: "i-unjs-nitro", key: "nitro", label: "Nitro" },
  { color: "#ef4444", icon: "i-simple-icons-tanstack", key: "tanstack", label: "TanStack Start" },
  { color: "#6366f1", icon: "i-lucide-server", key: "h3", label: "H3 server" },
]

const hostOptions: EnvironmentOption[] = [
  { color: "#f48120", icon: "i-simple-icons-cloudflare", key: "cloudflare", label: "Cloudflare" },
  { color: "#52525b", icon: "i-simple-icons-vercel", key: "vercel", label: "Vercel" },
  { color: "#00c7b7", icon: "i-simple-icons-netlify", key: "netlify", label: "Netlify" },
  { color: "#475569", icon: "i-simple-icons-deno", key: "deno", label: "Deno" },
  { color: "#5fa04e", icon: "i-simple-icons-nodedotjs", key: "node", label: "Node" },
  { color: "#2496ed", icon: "i-simple-icons-docker", key: "docker", label: "Docker / self-hosted" },
]

const selectedProjectId = ref(projects[0]!.id)
const selectedFilePath = ref(projects[0]!.files[0]!.path)
const propertySelectionKey = ref<AgentPropertyKey>()
const capabilitySelectionKey = ref<string>()
const channelSelectionKey = ref<string>()
const frameworkKey = ref("nuxt")
const hostKey = ref("cloudflare")
const projectAgentConfigs = reactive<Record<string, AgentConfig>>({
  reviewer: {
    defaultPropertyKeys: ["driver", "box", "workspace"],
    visiblePropertyKeys: ["driver", "runtime", "box", "workspace", "capabilities", "channels"],
    driverKey: "codex",
    runtimeKey: "workflow",
    boxKey: "trusted",
    workspaceKey: "github",
    capabilityKeys: ["browser", "repository", "skills"],
    channelKeys: ["github"],
  },
  nuxt: {
    defaultPropertyKeys: ["driver", "workspace"],
    visiblePropertyKeys: ["driver", "runtime", "workspace", "capabilities", "channels"],
    driverKey: "model",
    runtimeKey: "workflow",
    boxKey: "trusted",
    workspaceKey: "local",
    capabilityKeys: ["mcp", "rate-limit", "skills"],
    channelKeys: ["http"],
  },
  status: {
    defaultPropertyKeys: ["driver", "box", "workspace"],
    visiblePropertyKeys: ["driver", "runtime", "box", "workspace", "capabilities", "channels"],
    driverKey: "claude",
    runtimeKey: "workflow",
    boxKey: "trusted",
    workspaceKey: "local",
    capabilityKeys: ["web-search", "browser", "memory", "skills"],
    channelKeys: ["web-chat"],
  },
})

const selectContent = {
  align: "start" as const,
  collisionPadding: 12,
  sideOffset: 6,
}

const selectUi = {
  base: "min-h-7 rounded-md shadow-xs",
  value: "overflow-visible text-clip whitespace-nowrap",
  placeholder: "overflow-visible text-clip whitespace-nowrap",
  content: "w-max min-w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-default bg-default shadow-md ring-0",
  viewport: "p-1",
  item: "min-h-8 gap-2 rounded-md px-2 py-1.5 before:hidden data-highlighted:bg-elevated",
  itemLeadingIcon: "size-4 shrink-0 text-muted",
  itemWrapper: "min-w-0 overflow-visible",
  itemLabel: "overflow-visible text-clip whitespace-normal leading-4 sm:whitespace-nowrap",
  itemTrailing: "ms-auto flex w-4 shrink-0 items-center justify-end",
  itemTrailingIcon: "size-3.5 text-highlighted",
  trailingIcon: "size-3.5",
}
const catalogSelectUi = {
  ...selectUi,
  viewport: "max-h-72 p-1",
}

const projectItems = projects.map(project => ({
  icon: "i-lucide-folder",
  label: project.name,
  value: project.id,
}))
const projectSelectUi = {
  ...selectUi,
  base: "min-h-8 w-full rounded-md bg-default px-2 shadow-none",
  content: "w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-default bg-default shadow-lg ring-0",
  item: "min-h-9 gap-2 rounded-md px-2.5 py-2 before:hidden data-highlighted:bg-elevated",
  itemLabel: "truncate font-medium",
}

const selectedProject = computed(() =>
  projects.find(project => project.id === selectedProjectId.value) ?? projects[0]!,
)
const selectedFile = computed(() =>
  selectedProject.value.files.find(file => file.path === selectedFilePath.value)
  ?? selectedProject.value.files[0]!,
)
const selectedAgentConfig = computed(() => projectAgentConfigs[selectedProjectId.value]!)
const hasVisibleBox = computed(() => selectedAgentConfig.value.visiblePropertyKeys.includes("box"))
const hasVisibleChannels = computed(() => selectedAgentConfig.value.visiblePropertyKeys.includes("channels"))
const driverItems = computed(() => driverOptions
  .filter(option => !hasVisibleBox.value || option.key === "codex" || option.key === "claude")
  .map(option => ({ icon: option.icon, label: option.label, value: option.key })))
const runtimeItems = runtimeOptions.map(option => ({ icon: option.icon, label: option.label, value: option.key }))
const boxItems = boxOptions.map(option => ({ icon: option.icon, label: option.label, value: option.key }))
const workspaceItems = workspaceOptions.map(option => ({ icon: option.icon, label: option.label, value: option.key }))
const selectedDriver = computed(() => driverOptions.find(option => option.key === selectedAgentConfig.value.driverKey)!)
const selectedRuntime = computed(() => runtimeOptions.find(option => option.key === selectedAgentConfig.value.runtimeKey)!)
const selectedBox = computed(() => boxOptions.find(option => option.key === selectedAgentConfig.value.boxKey)!)
const selectedWorkspace = computed(() => workspaceOptions.find(option => option.key === selectedAgentConfig.value.workspaceKey)!)
const availablePropertyItems = computed(() => agentPropertyOrder
  .filter(key =>
    !selectedAgentConfig.value.visiblePropertyKeys.includes(key)
    && (key !== "box" || selectedAgentConfig.value.driverKey === "codex" || selectedAgentConfig.value.driverKey === "claude")
    && (key !== "channels" || !selectedAgentConfig.value.capabilityKeys.includes("chat")),
  )
  .map(key => ({
    icon: agentProperties[key].icon,
    label: agentProperties[key].title,
    value: key,
  })))
const availableCapabilityItems = computed(() => capabilityOptions
  .filter(option =>
    !selectedAgentConfig.value.capabilityKeys.includes(option.key)
    && (option.key !== "browser" || hasVisibleBox.value)
    && (
      option.key !== "chat"
      || !hasVisibleChannels.value
      || selectedAgentConfig.value.channelKeys.length === 0
    ),
  )
  .map(option => ({
    icon: option.icon,
    label: option.label,
    value: option.key,
  })))
const availableChannelItems = computed(() => channelOptions
  .filter(option =>
    !selectedAgentConfig.value.channelKeys.includes(option.key)
    && !selectedAgentConfig.value.capabilityKeys.includes("chat"),
  )
  .map(option => ({
    icon: option.icon,
    label: option.label,
    value: option.key,
  })))
const syntaxThemes = {
  light: "material-theme-lighter",
  default: "material-theme",
  dark: "material-theme-palenight",
}
const highlightedSource = computed(() => {
  const language = selectedFile.value.path.endsWith(".ts") ? "ts" : "md"
  return `\`\`\`${language}\n${selectedFile.value.content}\n\`\`\``
})
const highlightedContent = shallowRef()

function nodeText(node: HastNode): string {
  if (node.type === "text") {
    return node.value ?? ""
  }

  return node.children?.map(nodeText).join("") ?? ""
}

function syntaxHighlightPlugin() {
  return async (tree: HastNode) => {
    const tasks: Promise<void>[] = []
    const styles = new Set<string>()

    function visit(node: HastNode) {
      const language = node.properties?.language

      if (node.tagName === "pre" && typeof language === "string" && language !== "text") {
        tasks.push(highlighter(nodeText(node), language, syntaxThemes).then((result) => {
          const className = Array.isArray(node.properties?.className)
            ? node.properties.className.join(" ")
            : String(node.properties?.className ?? "")
          const code = node.children?.find(child => child.tagName === "code")

          node.properties = {
            ...node.properties,
            className: `${className} ${result.className}`.trim(),
            style: result.inlineStyle,
          }

          if (code) {
            code.children = result.tree as HastNode[]
          }

          if (result.style) {
            styles.add(result.style)
          }
        }))
      }

      node.children?.forEach(visit)
    }

    visit(tree)
    await Promise.all(tasks)

    if (styles.size) {
      tree.children?.push({
        type: "element",
        tagName: "style",
        properties: {},
        children: [{ type: "text", value: [...styles].join("") }],
      })
    }
  }
}

watchEffect(async (onCleanup) => {
  let cancelled = false

  onCleanup(() => {
    cancelled = true
  })

  if (selectedFile.value.path.endsWith(".ts")) {
    highlightedContent.value = undefined
    return
  }

  const content = await parseMarkdown(highlightedSource.value, {
    highlight: {
      highlighter,
      theme: syntaxThemes,
    },
    rehype: {
      plugins: {
        highlight: {
          instance: syntaxHighlightPlugin,
        },
      },
    },
  })

  if (!cancelled) {
    highlightedContent.value = content
  }
})

watch(selectedProjectId, () => {
  selectedFilePath.value = selectedProject.value.files[0]!.path
  propertySelectionKey.value = undefined
  capabilitySelectionKey.value = undefined
  channelSelectionKey.value = undefined
})

function capabilityOption(key: string) {
  return capabilityOptions.find(option => option.key === key)!
}

function capabilityItemsFor(currentKey: string) {
  return capabilityOptions
    .filter(option =>
      option.key === currentKey
      || (
        !selectedAgentConfig.value.capabilityKeys.includes(option.key)
        && (option.key !== "browser" || hasVisibleBox.value)
        && (
          option.key !== "chat"
          || !hasVisibleChannels.value
          || selectedAgentConfig.value.channelKeys.length === 0
        )
      ),
    )
    .map(option => ({
      icon: option.icon,
      label: option.label,
      value: option.key,
    }))
}

function channelOption(key: string) {
  return channelOptions.find(option => option.key === key)!
}

function channelItemsFor(currentKey: string) {
  return channelOptions
    .filter(option => option.key === currentKey || !selectedAgentConfig.value.channelKeys.includes(option.key))
    .map(option => ({
      icon: option.icon,
      label: option.label,
      value: option.key,
    }))
}

async function addProperty(value: unknown) {
  if (typeof value !== "string" || !agentPropertyOrder.includes(value as AgentPropertyKey)) {
    return
  }

  const key = value as AgentPropertyKey
  if (!selectedAgentConfig.value.visiblePropertyKeys.includes(key)) {
    selectedAgentConfig.value.visiblePropertyKeys.push(key)
  }

  await nextTick()
  propertySelectionKey.value = undefined
}

function removeProperty(key: AgentPropertyKey) {
  if (selectedAgentConfig.value.defaultPropertyKeys.includes(key)) {
    return
  }

  selectedAgentConfig.value.visiblePropertyKeys = selectedAgentConfig.value.visiblePropertyKeys
    .filter(propertyKey => propertyKey !== key)
}

async function addCapability(value: unknown) {
  if (typeof value !== "string" || selectedAgentConfig.value.capabilityKeys.includes(value)) {
    return
  }

  selectedAgentConfig.value.capabilityKeys.push(value)
  await nextTick()
  capabilitySelectionKey.value = undefined
}

function removeCapability(index: number) {
  selectedAgentConfig.value.capabilityKeys.splice(index, 1)
}

async function addChannel(value: unknown) {
  if (typeof value !== "string" || selectedAgentConfig.value.channelKeys.includes(value)) {
    return
  }

  selectedAgentConfig.value.channelKeys.push(value)
  await nextTick()
  channelSelectionKey.value = undefined
}

function removeChannel(index: number) {
  selectedAgentConfig.value.channelKeys.splice(index, 1)
}

function selectFramework(key: string) {
  frameworkKey.value = key
}

function selectHost(key: string) {
  hostKey.value = key
}
</script>

<template>
  <section class="playground-stage min-w-0">
    <div class="workbench-body">
      <aside class="file-tree">
        <USelect
          v-model="selectedProjectId"
          :items="projectItems"
          :content="selectContent"
          :ui="projectSelectUi"
          value-key="value"
          icon="i-lucide-folder-open"
          aria-label="Select example project"
          size="sm"
          color="neutral"
          variant="outline"
          class="project-select"
        >
          <template #default>
            <span class="truncate">{{ selectedProject.name }}</span>
          </template>
        </USelect>
        <p class="tree-path">
          <UIcon name="i-lucide-folder-tree" class="size-3.5 shrink-0" />
          <span class="truncate">{{ selectedProject.rootPath }}/</span>
        </p>

        <button
          v-for="file in selectedProject.files"
          :key="file.path"
          class="tree-file"
          :class="{ 'is-active': selectedFile.path === file.path }"
          type="button"
          @click="selectedFilePath = file.path"
        >
          <UIcon
            :name="file.path.endsWith('.ts') ? 'i-vscode-icons-file-type-typescript' : 'i-vscode-icons-file-type-markdown'"
            class="size-4 shrink-0"
          />
          <span class="truncate">{{ file.path.replace(`${selectedProject.rootPath}/`, "") }}</span>
        </button>
      </aside>

      <div class="editor-pane">
        <div v-if="selectedFile.path.endsWith('.ts')" class="agent-code">
          <div class="agent-code-inner">
            <p><span class="syntax-keyword">export default</span> <span class="text-highlighted">defineAgent</span>({</p>

            <div
              v-for="propertyKey in selectedAgentConfig.visiblePropertyKeys"
              :key="propertyKey"
              class="code-row"
              :class="{ 'capability-code-row': propertyKey === 'capabilities' || propertyKey === 'channels' }"
            >
              <span class="property-key">
                <PropertyHelp
                  :label="agentProperties[propertyKey].label"
                  :title="agentProperties[propertyKey].title"
                  :description="agentProperties[propertyKey].description"
                  :to="agentProperties[propertyKey].to"
                />:
              </span>

              <USelect
                v-if="propertyKey === 'driver'"
                v-model="selectedAgentConfig.driverKey"
                :items="driverItems"
                :icon="selectedDriver.icon"
                :content="selectContent"
                :ui="selectUi"
                value-key="value"
                aria-label="Agent Driver"
                size="xs"
                color="neutral"
                variant="outline"
                class="code-select driver-select"
              >
                <template #default>
                  <span>{{ selectedDriver.code }}</span>
                </template>
              </USelect>

              <USelect
                v-else-if="propertyKey === 'runtime'"
                v-model="selectedAgentConfig.runtimeKey"
                :items="runtimeItems"
                :icon="selectedRuntime.icon"
                :content="selectContent"
                :ui="selectUi"
                value-key="value"
                aria-label="Agent execution runtime"
                size="xs"
                color="neutral"
                variant="outline"
                class="code-select runtime-select"
              >
                <template #default>
                  <span>{{ selectedRuntime.code }}</span>
                </template>
              </USelect>

              <USelect
                v-else-if="propertyKey === 'box'"
                v-model="selectedAgentConfig.boxKey"
                :items="boxItems"
                :icon="selectedBox.icon"
                :content="selectContent"
                :ui="selectUi"
                value-key="value"
                aria-label="Agent execution box"
                size="xs"
                color="neutral"
                variant="outline"
                class="code-select box-select"
              >
                <template #default>
                  <span>{{ selectedBox.code }}</span>
                </template>
              </USelect>

              <USelect
                v-else-if="propertyKey === 'workspace'"
                v-model="selectedAgentConfig.workspaceKey"
                :items="workspaceItems"
                :icon="selectedWorkspace.icon"
                :content="selectContent"
                :ui="selectUi"
                value-key="value"
                aria-label="Workspace store"
                size="xs"
                color="neutral"
                variant="outline"
                class="code-select workspace-select"
              >
                <template #default>
                  <span>{{ selectedWorkspace.code }}</span>
                </template>
              </USelect>

              <div
                v-else-if="propertyKey === 'capabilities'"
                class="capability-array"
              >
                <span class="capability-bracket">[</span>
                <div
                  v-for="(capabilityKey, index) in selectedAgentConfig.capabilityKeys"
                  :key="`${capabilityKey}-${index}`"
                  class="capability-item"
                >
                  <USelect
                    v-model="selectedAgentConfig.capabilityKeys[index]"
                    :items="capabilityItemsFor(capabilityKey)"
                    :icon="capabilityOption(capabilityKey).icon"
                    :content="selectContent"
                    :ui="catalogSelectUi"
                    value-key="value"
                    :aria-label="`Capability ${index + 1}`"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    class="code-select capability-select"
                  >
                    <template #default>
                      <span>{{ capabilityOption(capabilityKey).code }}</span>
                    </template>
                  </USelect>
                  <span>,</span>
                  <UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    class="property-remove"
                    :aria-label="`Remove ${capabilityOption(capabilityKey).label} capability`"
                    @click="removeCapability(index)"
                  />
                </div>
                <div
                  v-if="availableCapabilityItems.length"
                  class="capability-add-row"
                >
                  <USelect
                    v-model="capabilitySelectionKey"
                    :items="availableCapabilityItems"
                    :content="selectContent"
                    :ui="catalogSelectUi"
                    value-key="value"
                    icon="i-lucide-plus"
                    placeholder="Add capability"
                    aria-label="Add Agent capability"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    class="capability-add"
                    @update:model-value="addCapability"
                  />
                </div>
                <span class="capability-bracket">],</span>
              </div>

              <div
                v-else-if="propertyKey === 'channels'"
                class="channel-array"
              >
                <span class="channel-bracket">{</span>
                <div
                  v-for="(channelKey, index) in selectedAgentConfig.channelKeys"
                  :key="`${channelKey}-${index}`"
                  class="channel-item"
                >
                  <USelect
                    v-model="selectedAgentConfig.channelKeys[index]"
                    :items="channelItemsFor(channelKey)"
                    :icon="channelOption(channelKey).icon"
                    :content="selectContent"
                    :ui="catalogSelectUi"
                    value-key="value"
                    :aria-label="`Channel ${index + 1}`"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    class="code-select channel-select"
                  >
                    <template #default>
                      <span>{{ channelOption(channelKey).code }}</span>
                    </template>
                  </USelect>
                  <span>,</span>
                  <UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    class="property-remove"
                    :aria-label="`Remove ${channelOption(channelKey).label} channel`"
                    @click="removeChannel(index)"
                  />
                </div>
                <div
                  v-if="availableChannelItems.length"
                  class="channel-add-row"
                >
                  <USelect
                    v-model="channelSelectionKey"
                    :items="availableChannelItems"
                    :content="selectContent"
                    :ui="catalogSelectUi"
                    value-key="value"
                    icon="i-lucide-plus"
                    placeholder="Add channel"
                    aria-label="Add Agent channel"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    class="channel-add"
                    @update:model-value="addChannel"
                  />
                </div>
                <span class="channel-bracket">},</span>
              </div>

              <span v-if="propertyKey !== 'capabilities' && propertyKey !== 'channels'">,</span>
              <UButton
                v-if="!selectedAgentConfig.defaultPropertyKeys.includes(propertyKey)"
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="xs"
                class="property-remove"
                :aria-label="`Remove ${agentProperties[propertyKey].title}`"
                @click="removeProperty(propertyKey)"
              />
            </div>

            <div v-if="availablePropertyItems.length" class="code-row property-add-row">
              <USelect
                v-model="propertySelectionKey"
                :items="availablePropertyItems"
                :content="selectContent"
                :ui="selectUi"
                value-key="value"
                icon="i-lucide-plus"
                placeholder="Add property"
                aria-label="Add Agent property"
                size="xs"
                color="neutral"
                variant="outline"
                class="property-add"
                @update:model-value="addProperty"
              />
            </div>

            <p>})</p>
          </div>
        </div>
        <MDCRenderer
          v-else-if="highlightedContent"
          :body="highlightedContent.body"
          :data="highlightedContent.data"
          class="code-block-wrapper editor-code"
        />
      </div>
    </div>

    <div class="environment-panel">
      <div class="environment-group">
        <span class="environment-label">Build with</span>
        <div class="logo-row framework-row" role="group" aria-label="Build with framework">
          <UButton
            v-for="option in frameworkOptions"
            :key="option.key"
            color="neutral"
            variant="ghost"
            class="logo-option"
            :class="{ 'is-selected': frameworkKey === option.key }"
            :style="{ '--brand-color': option.color }"
            :aria-label="option.label"
            :aria-pressed="frameworkKey === option.key"
            @click="selectFramework(option.key)"
          >
            <UIcon :name="option.icon" class="logo-mark" />
            <span class="logo-name">{{ option.label }}</span>
          </UButton>
        </div>
      </div>

      <div class="environment-group">
        <span class="environment-label">Deploy on</span>
        <div class="logo-row host-row" role="group" aria-label="Deploy on host">
          <UButton
            v-for="option in hostOptions"
            :key="option.key"
            color="neutral"
            variant="ghost"
            class="logo-option"
            :class="{ 'is-selected': hostKey === option.key }"
            :style="{ '--brand-color': option.color }"
            :aria-label="option.label"
            :aria-pressed="hostKey === option.key"
            @click="selectHost(option.key)"
          >
            <UIcon :name="option.icon" class="logo-mark" />
            <span class="logo-name">{{ option.label }}</span>
          </UButton>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.playground-stage {
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
  background: var(--ui-bg);
  box-shadow: 0 24px 70px -52px rgb(15 23 42 / 0.55);
}

.project-select {
  width: 100%;
  min-width: 0;
  font-size: 0.65rem;
}

.workbench-body {
  display: grid;
  min-height: 28.25rem;
  grid-template-columns: 13rem minmax(0, 1fr);
}

.file-tree {
  border-right: 1px solid var(--ui-border);
  padding: 0.55rem 0.4rem 0.7rem;
  background: color-mix(in srgb, var(--ui-bg-muted) 34%, transparent);
}

.tree-path {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.45rem;
  padding: 0.3rem 0.45rem;
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 0.58rem;
  font-weight: 500;
}

.tree-file {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
  border-radius: 0.3rem;
  padding: 0.32rem 0.45rem 0.32rem 1.25rem;
  color: var(--ui-text-muted);
  font-size: 0.66rem;
  text-align: left;
}

.tree-file:hover,
.tree-file.is-active {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

.editor-pane {
  min-width: 0;
  background: color-mix(in srgb, var(--ui-bg) 96%, var(--ui-bg-muted));
}

.agent-code {
  position: relative;
  height: 25.85rem;
  overflow: auto;
  padding: 0 1.25rem 1rem;
  scrollbar-color: var(--ui-border-accented) transparent;
}

.agent-code-inner {
  min-width: 32rem;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.65rem;
  line-height: 1.55;
}

.agent-code-inner > p {
  display: flex;
  min-height: 2rem;
  align-items: center;
}

.code-row {
  display: flex;
  min-height: 2rem;
  align-items: center;
  gap: 0.35rem;
  padding-left: 1rem;
  white-space: nowrap;
}

.capability-code-row {
  align-items: flex-start;
}

.capability-code-row > .property-key {
  padding-top: 0.35rem;
}

.capability-array,
.channel-array {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
}

.capability-bracket,
.channel-bracket {
  display: flex;
  min-height: 2rem;
  align-items: center;
}

.capability-item,
.channel-item {
  display: flex;
  min-height: 2rem;
  align-items: center;
  gap: 0.25rem;
  padding-left: 1rem;
}

.property-add-row {
  padding-top: 0.25rem;
}

.syntax-keyword {
  color: #7c3aed;
}

.code-select,
.property-add,
.capability-add,
.channel-add {
  width: max-content;
  max-width: none;
  border-radius: 0.375rem;
  font-family: var(--font-mono);
}

.driver-select,
.runtime-select {
  min-width: 12rem;
}

.driver-select {
  background: color-mix(in srgb, #8b5cf6 10%, var(--ui-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #8b5cf6 30%, transparent);
  color: #6d28d9;
}

.runtime-select {
  background: color-mix(in srgb, #f59e0b 10%, var(--ui-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #f59e0b 30%, transparent);
  color: #b45309;
}

.box-select {
  min-width: 16rem;
  background: color-mix(in srgb, #f97316 9%, var(--ui-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #f97316 28%, transparent);
  color: #c2410c;
}

.workspace-select {
  min-width: 17rem;
  background: color-mix(in srgb, #6366f1 9%, var(--ui-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #6366f1 28%, transparent);
  color: #4338ca;
}

.capability-select {
  min-width: 19rem;
  background: color-mix(in srgb, #0ea5e9 9%, var(--ui-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #0ea5e9 26%, transparent);
  color: #0369a1;
}

.capability-add,
.channel-add {
  min-width: 10rem;
}

.capability-add-row,
.channel-add-row {
  display: flex;
  min-height: 2rem;
  align-items: center;
  padding-left: 1rem;
}

.channel-select {
  min-width: 20rem;
  background: color-mix(in srgb, #10b981 9%, var(--ui-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #10b981 26%, transparent);
  color: #047857;
}

.property-add {
  min-width: 10rem;
}

.property-remove {
  min-height: 1.5rem;
  min-width: 1.5rem;
  border-radius: 0.25rem;
}

.editor-code {
  height: 25.85rem;
  overflow: auto;
}

.editor-code :deep(pre) {
  min-height: 100%;
  margin: 0 !important;
  padding: 0 1.25rem 1rem !important;
  background: transparent !important;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.65rem !important;
  line-height: 1.55 !important;
  white-space: pre;
}

.editor-code :deep(code) {
  display: block;
  font-family: inherit;
}

.editor-code :deep(.line) {
  display: block;
  min-height: 1.55em;
}

.environment-panel {
  border-top: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-bg-muted) 48%, transparent);
}

.environment-group {
  padding: 0.45rem 0.65rem 0.55rem;
}

.environment-group + .environment-group {
  border-top: 1px solid var(--ui-border);
}

.environment-label {
  display: block;
  padding: 0 0.25rem 0.2rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6rem;
  font-weight: 600;
  line-height: 1rem;
}

.logo-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.2rem;
}

.logo-option {
  min-height: 2.35rem;
  min-width: 0;
  width: 100%;
  justify-content: center;
  gap: 0.35rem;
  border: 0;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
}

.logo-mark {
  width: 1rem;
  height: 1rem;
  color: var(--brand-color);
  opacity: 0.72;
}

.logo-name {
  min-width: 0;
  overflow: hidden;
  font-size: 0.6rem;
  font-weight: 500;
  line-height: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logo-option.is-selected {
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.08), inset 0 0 0 1px color-mix(in srgb, var(--brand-color) 28%, var(--ui-border));
}

.logo-option.is-selected .logo-mark {
  opacity: 1;
}

:global(.dark) .syntax-keyword { color: #c4b5fd; }
:global(.dark) .driver-select { color: #c4b5fd; }
:global(.dark) .runtime-select { color: #fcd34d; }
:global(.dark) .workspace-select { color: #a5b4fc; }
:global(.dark) .capability-select { color: #7dd3fc; }
:global(.dark) .channel-select { color: #6ee7b7; }

@media (min-width: 40rem) {
  .framework-row {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .host-row {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

@media (hover: hover) and (pointer: fine) {
  .property-remove {
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }

  .code-row:not(.capability-code-row):hover > .property-remove,
  .capability-item:hover > .property-remove,
  .channel-item:hover > .property-remove,
  .capability-code-row:has(> .property-key:hover) > .property-remove,
  .capability-code-row:has(> .capability-array > .capability-bracket:first-child:hover) > .property-remove,
  .capability-code-row:has(> .channel-array > .channel-bracket:first-child:hover) > .property-remove,
  .property-remove:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }

  .logo-option:hover {
    background: color-mix(in srgb, var(--brand-color) 7%, var(--ui-bg));
    color: var(--ui-text-highlighted);
  }

  .logo-option:hover .logo-mark {
    opacity: 1;
  }
}

@media (max-width: 639px) {
  .workbench-body {
    grid-template-columns: 11rem minmax(18rem, 1fr);
    overflow-x: auto;
  }
}
</style>
