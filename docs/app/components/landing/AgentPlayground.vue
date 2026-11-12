<script setup lang="ts">
import { brandColors } from "../../data/brand-colors"
import PropertyHelp from "./PropertyHelp.vue"

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

type AgentPropertyKey = "driver" | "runtime" | "workspace" | "capabilities" | "channels"

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
  workspaceKey: string
  capabilityKeys: string[]
  channelKeys: string[]
}

type EnvironmentOption = {
  color?: string
  icon: string
  label: string
  value: string
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
        content: `import { codexDriver, defineAgent } from "@vite-hub/agent"
import { github } from "@vite-hub/agent/channels"
import {
  browser,
  forge,
  skills,
} from "@vite-hub/agent/capabilities"

export default defineAgent({
  driver: codexDriver(),
  workspace: {
    name: "repository",
    mode: "write",
  },
  channels: {
    github: github({ pullRequest: true }),
  },
  capabilities: [
    browser(),
    forge({ mode: "write" }),
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
        content: `import { codexDriver, defineAgent } from "@vite-hub/agent"
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
  driver: codexDriver(),
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
        content: `import { agentWorkflow, claudeCodeDriver, defineAgent } from "@vite-hub/agent"
import { webChat } from "@vite-hub/agent/channels"
import {
  browser,
  memory,
  skills,
  webSearch,
  workspaceJsonlMemoryStore,
} from "@vite-hub/agent/capabilities"

export default defineAgent({
  driver: claudeCodeDriver(),
  runtime: agentWorkflow("agent"),
  workspace: {
    name: "research",
    mode: "write",
  },
  channels: {
    web: webChat(),
  },
  capabilities: [
    webSearch({ mode: "tool", provider: "exa" }),
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
    description: "Chooses how each invocation runs: through a coding provider, a model, or your own function.",
    icon: "i-lucide-bot",
    label: "driver",
    title: "Agent Driver",
    to: "/docs/agents/agent-drivers",
  },
  runtime: {
    description: "Chooses inline execution or a durable workflow that can survive waits, retries, and restarts.",
    icon: "i-lucide-workflow",
    label: "runtime",
    title: "Execution runtime",
    to: "/docs/workflows",
  },
  workspace: {
    description: "Provides the persistent file tree and selects where the Agent's working state is stored.",
    icon: "i-lucide-folder-tree",
    label: "workspace",
    title: "Workspace",
    to: "/docs/agents/workspace-context",
  },
  capabilities: {
    description: "Adds named abilities such as browser, Git, scheduling, and Skills.",
    icon: "i-lucide-blocks",
    label: "capabilities",
    title: "Capabilities",
    to: "/docs/agents/capabilities/official",
  },
  channels: {
    description: "Connects the Agent to triggers and delivery surfaces such as GitHub, Slack, and HTTP.",
    icon: "i-lucide-radio-tower",
    label: "channels",
    title: "Channels",
    to: "/docs/agents/channels",
  },
}
const agentPropertyOrder: readonly AgentPropertyKey[] = [
  "driver",
  "runtime",
  "workspace",
  "capabilities",
  "channels",
]

const driverOptions = [
  { code: "codexDriver()", icon: "i-simple-icons-openai", key: "codex", label: "Codex provider" },
  { code: "claudeCodeDriver({ permissions: 'ask' })", icon: "i-simple-icons-anthropic", key: "claude", label: "Claude Code provider" },
  { code: "{ model: 'openai/gpt-5.1-mini' }", icon: "i-simple-icons-vercel", key: "model", label: "Bare model" },
  { code: "{ run: customAgent }", icon: "i-lucide-braces", key: "custom", label: "Custom runner" },
] satisfies PlaygroundOption[]

const runtimeOptions = [
  { code: "agentWorkflow('agent')", icon: "i-lucide-workflow", key: "workflow", label: "Durable workflow" },
  { code: "false", icon: "i-lucide-zap", key: "inline", label: "Inline execution" },
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
  { code: "forge({ mode: 'write' })", icon: "i-lucide-git-pull-request", key: "forge", label: "Forge" },
  { code: "mcp({ servers: { nuxt } })", icon: "i-lucide-plug-zap", key: "mcp", label: "MCP servers" },
  { code: "webSearch({ mode: 'tool', provider: 'exa' })", icon: "i-lucide-search", key: "web-search", label: "Web search" },
  { code: "fetch({ tools })", icon: "i-lucide-globe", key: "fetch", label: "Fetch tools" },
  { code: "openapi({ spec, operations })", icon: "i-lucide-braces", key: "openapi", label: "OpenAPI tools" },
  { code: "transcribe({ model: transcriptionModel })", icon: "i-lucide-audio-lines", key: "transcribe", label: "Transcription" },
  { code: "rateLimit({ limiter: messages })", icon: "i-lucide-gauge", key: "rate-limit", label: "Rate limit" },
  { code: "title()", icon: "i-lucide-heading", key: "title", label: "Title" },
  { code: "progressSummary()", icon: "i-lucide-list-collapse", key: "progress-summary", label: "Progress summary" },
  { code: "usage()", icon: "i-lucide-chart-no-axes-column", key: "usage", label: "Usage" },
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

// Vercel, Deno, and the generic H3 icon have no brand color, so they take the text color.
const frameworkOptions: EnvironmentOption[] = [
  { color: brandColors.vite, icon: "i-simple-icons-vite", value: "vite", label: "Vite" },
  { color: brandColors.nuxt, icon: "i-simple-icons-nuxt", value: "nuxt", label: "Nuxt" },
  { color: brandColors.nitro, icon: "i-unjs-nitro", value: "nitro", label: "Nitro" },
  { color: brandColors.tanstack, icon: "i-simple-icons-tanstack", value: "tanstack", label: "TanStack Start" },
  { icon: "i-lucide-server", value: "h3", label: "H3 server" },
]

const hostOptions: EnvironmentOption[] = [
  { color: brandColors.cloudflare, icon: "i-simple-icons-cloudflare", value: "cloudflare", label: "Cloudflare" },
  { icon: "i-simple-icons-vercel", value: "vercel", label: "Vercel" },
  { color: brandColors.netlify, icon: "i-simple-icons-netlify", value: "netlify", label: "Netlify" },
  { icon: "i-simple-icons-deno", value: "deno", label: "Deno" },
  { color: brandColors.node, icon: "i-simple-icons-nodedotjs", value: "node", label: "Node" },
  { color: brandColors.docker, icon: "i-simple-icons-docker", value: "docker", label: "Docker / self-hosted" },
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
    defaultPropertyKeys: ["driver", "workspace"],
    visiblePropertyKeys: ["driver", "runtime", "workspace", "capabilities", "channels"],
    driverKey: "codex",
    runtimeKey: "workflow",
    workspaceKey: "github",
    capabilityKeys: ["browser", "forge", "skills"],
    channelKeys: ["github"],
  },
  nuxt: {
    defaultPropertyKeys: ["driver", "workspace"],
    visiblePropertyKeys: ["driver", "runtime", "workspace", "capabilities", "channels"],
    driverKey: "model",
    runtimeKey: "workflow",
    workspaceKey: "local",
    capabilityKeys: ["mcp", "rate-limit", "skills"],
    channelKeys: ["http"],
  },
  status: {
    defaultPropertyKeys: ["driver", "workspace"],
    visiblePropertyKeys: ["driver", "runtime", "workspace", "capabilities", "channels"],
    driverKey: "claude",
    runtimeKey: "workflow",
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

// Code values stay on one line, and the menus grow to fit them.
const selectUi = {
  value: "overflow-visible text-clip whitespace-nowrap",
  placeholder: "overflow-visible text-clip whitespace-nowrap",
  content: "w-max min-w-64 max-w-[calc(100vw-1rem)]",
}

const projectItems = projects.map(project => ({
  icon: "i-lucide-folder",
  label: project.name,
  value: project.id,
}))
const projectSelectUi = {
  content: "w-64 max-w-[calc(100vw-1rem)]",
}
const selectedProject = computed(() =>
  projects.find(project => project.id === selectedProjectId.value) ?? projects[0]!,
)
const selectedFile = computed(() =>
  selectedProject.value.files.find(file => file.path === selectedFilePath.value)
  ?? selectedProject.value.files[0]!,
)
const fileItems = computed(() => selectedProject.value.files.map(file => ({
  icon: file.path.endsWith(".ts") ? "i-vscode-icons-file-type-typescript" : "i-vscode-icons-file-type-markdown",
  label: file.path.replace(`${selectedProject.value.rootPath}/`, ""),
  value: file.path,
})))

const selectedAgentConfig = computed(() => projectAgentConfigs[selectedProjectId.value]!)
const hasVisibleChannels = computed(() => selectedAgentConfig.value.visiblePropertyKeys.includes("channels"))
const hasProviderDriver = computed(() =>
  selectedAgentConfig.value.driverKey === "codex" || selectedAgentConfig.value.driverKey === "claude",
)
const hasProviderOnlyCapability = computed(() => selectedAgentConfig.value.capabilityKeys.some(key => key === "access" || key === "browser"))
const driverItems = computed(() => driverOptions
  .filter(option =>
    !hasProviderOnlyCapability.value
    || option.key === "codex"
    || option.key === "claude",
  )
  .map(option => ({ icon: option.icon, label: option.label, value: option.key })))
const runtimeItems = runtimeOptions.map(option => ({ icon: option.icon, label: option.label, value: option.key }))
const workspaceItems = workspaceOptions.map(option => ({ icon: option.icon, label: option.label, value: option.key }))
const selectedDriver = computed(() => driverOptions.find(option => option.key === selectedAgentConfig.value.driverKey)!)
const selectedRuntime = computed(() => runtimeOptions.find(option => option.key === selectedAgentConfig.value.runtimeKey)!)
const selectedWorkspace = computed(() => workspaceOptions.find(option => option.key === selectedAgentConfig.value.workspaceKey)!)
const availablePropertyItems = computed(() => agentPropertyOrder
  .filter(key =>
    !selectedAgentConfig.value.visiblePropertyKeys.includes(key)
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
    && (option.key !== "access" || hasProviderDriver.value)
    && (option.key !== "browser" || hasProviderDriver.value)
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
const highlightedLines = shallowRef<string>()

watchEffect(async (onCleanup) => {
  let cancelled = false

  onCleanup(() => {
    cancelled = true
  })

  if (selectedFile.value.path.endsWith(".ts")) {
    highlightedLines.value = undefined
    return
  }

  const lines = await highlightCodeLines(selectedFile.value.content, "md")

  if (!cancelled) {
    highlightedLines.value = lines
  }
})

watch(selectedProjectId, () => {
  selectedFilePath.value = selectedProject.value.files[0]!.path
  propertySelectionKey.value = undefined
  capabilitySelectionKey.value = undefined
  channelSelectionKey.value = undefined
})

function capabilityOption(key: string) {
  const option = capabilityOptions.find(option => option.key === key)!
  if (key !== "skills") {
    return option
  }

  const directory = {
    nuxt: "docs",
    reviewer: "review",
    status: "research",
  }[selectedProjectId.value]

  return {
    ...option,
    code: `skills({ path: './skills/${directory}' })`,
  }
}

function capabilityItemsFor(currentKey: string, index: number) {
  return capabilityOptions
    .filter(option =>
      option.key === currentKey
      || (
        !selectedAgentConfig.value.capabilityKeys.includes(option.key)
        && (option.key !== "access" || hasProviderDriver.value)
        && (option.key !== "access" || index === 0)
        && (option.key !== "browser" || hasProviderDriver.value)
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
  const key = agentPropertyOrder.find(propertyKey => propertyKey === value)
  if (!key) {
    return
  }

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

  if (key === "capabilities") {
    selectedAgentConfig.value.capabilityKeys = []
  }
  if (key === "channels") {
    selectedAgentConfig.value.channelKeys = []
  }
}

async function addCapability(value: unknown) {
  const key = capabilityOptions.find(option => option.key === value)?.key
  if (!key || selectedAgentConfig.value.capabilityKeys.includes(key)) {
    return
  }

  if (key === "access") {
    selectedAgentConfig.value.capabilityKeys.unshift(key)
  }
  else {
    selectedAgentConfig.value.capabilityKeys.push(key)
  }
  await nextTick()
  capabilitySelectionKey.value = undefined
}

function removeCapability(index: number) {
  selectedAgentConfig.value.capabilityKeys.splice(index, 1)
}

async function addChannel(value: unknown) {
  const key = channelOptions.find(option => option.key === value)?.key
  if (!key || selectedAgentConfig.value.channelKeys.includes(key)) {
    return
  }

  selectedAgentConfig.value.channelKeys.push(key)
  await nextTick()
  channelSelectionKey.value = undefined
}

function removeChannel(index: number) {
  selectedAgentConfig.value.channelKeys.splice(index, 1)
}
</script>

<template>
  <section class="playground-stage min-w-0 rounded-lg">
    <ol class="flex flex-wrap gap-x-5 gap-y-1 px-3 py-2.5 text-xs text-muted" aria-label="Explore an Agent">
      <li><span class="me-1.5 font-medium tabular-nums text-highlighted">1</span>Choose an Agent</li>
      <li><span class="me-1.5 font-medium tabular-nums text-highlighted">2</span>Edit its configuration</li>
      <li><span class="me-1.5 font-medium tabular-nums text-highlighted">3</span>Explore frameworks and hosts</li>
    </ol>
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

        <!-- Vertical tabs center their list by default. The file list fills the tree, so long paths truncate. -->
        <UTabs
          v-model="selectedFilePath"
          :items="fileItems"
          :content="false"
          orientation="vertical"
          class="flex-col items-stretch"
        />
      </aside>

      <div class="editor-pane">
        <div v-if="selectedFile.path.endsWith('.ts')" class="agent-code">
          <div class="agent-code-inner">
            <p><span><span class="syntax-keyword">export default</span> <span class="text-highlighted">defineAgent</span>({</span></p>

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
                class="code-select runtime-select"
              >
                <template #default>
                  <span>{{ selectedRuntime.code }}</span>
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
                    :items="capabilityItemsFor(capabilityKey, index)"
                    :icon="capabilityOption(capabilityKey).icon"
                    :content="selectContent"
                    :ui="selectUi"
                    value-key="value"
                    :aria-label="`Capability ${index + 1}`"
                    size="xs"
                    class="code-select capability-select"
                  >
                    <template #default>
                      <span>{{ capabilityOption(capabilityKey).code }}</span>
                    </template>
                  </USelect>
                  <span>,</span>
                  <UButton
                    icon="i-lucide-x"
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
                    :ui="selectUi"
                    value-key="value"
                    icon="i-lucide-plus"
                    placeholder="Add capability"
                    aria-label="Add Agent capability"
                    size="xs"
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
                    :ui="selectUi"
                    value-key="value"
                    :aria-label="`Channel ${index + 1}`"
                    size="xs"
                    class="code-select channel-select"
                  >
                    <template #default>
                      <span>{{ channelOption(channelKey).code }}</span>
                    </template>
                  </USelect>
                  <span>,</span>
                  <UButton
                    icon="i-lucide-x"
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
                    :ui="selectUi"
                    value-key="value"
                    icon="i-lucide-plus"
                    placeholder="Add channel"
                    aria-label="Add Agent channel"
                    size="xs"
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
                class="property-add"
                @update:model-value="addProperty"
              />
            </div>

            <p>})</p>
          </div>
        </div>
        <div v-else class="editor-code">
          <div v-if="highlightedLines" class="code-block-wrapper">
            <ProsePre language="md" :code="selectedFile.content" :class="['language-md', highlightedPreClass]">
              <code v-html="highlightedLines" />
            </ProsePre>
          </div>
          <p v-else role="status" class="p-4 text-xs text-muted">Loading file...</p>
        </div>
      </div>
    </div>

    <div class="environment-panel">
      <div class="environment-group">
        <span class="environment-label">Build with</span>
        <div class="environment-tabs">
          <UTabs v-model="frameworkKey" :items="frameworkOptions" :content="false" class="w-max min-w-full">
            <template #leading="{ item }">
              <UIcon :name="item.icon" class="size-4 shrink-0" :style="{ color: item.color }" />
            </template>
          </UTabs>
        </div>
      </div>

      <div class="environment-group">
        <span class="environment-label">Deploy on</span>
        <div class="environment-tabs">
          <UTabs v-model="hostKey" :items="hostOptions" :content="false" class="w-max min-w-full">
            <template #leading="{ item }">
              <UIcon :name="item.icon" class="size-4 shrink-0" :style="{ color: item.color }" />
            </template>
          </UTabs>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.playground-stage {
  display: grid;
  height: var(--agent-playground-height, 48rem);
  grid-template-rows: auto minmax(0, 1fr) auto;
  container-type: inline-size;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.project-select {
  width: 100%;
  min-width: 0;
  font-size: 0.65rem;
}

.workbench-body {
  display: grid;
  min-height: 0;
  grid-template-columns: 13rem minmax(0, 1fr);
}

.file-tree {
  min-height: 0;
  overflow: auto;
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

.editor-pane {
  min-height: 0;
  min-width: 0;
  background: color-mix(in srgb, var(--ui-bg) 96%, var(--ui-bg-muted));
}

.agent-code {
  position: relative;
  height: 100%;
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
  color: var(--ui-text-highlighted);
  font-weight: 500;
}

.code-select,
.property-add,
.capability-add,
.channel-add {
  width: max-content;
  max-width: none;
  font-family: var(--font-mono);
}

.driver-select,
.runtime-select {
  min-width: 12rem;
}

.workspace-select {
  min-width: 17rem;
}

.capability-select {
  min-width: 19rem;
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
}

.property-add {
  min-width: 10rem;
}

.property-remove {
  min-height: 1.5rem;
  min-width: 1.5rem;
}

.editor-code {
  height: 100%;
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

/* The tabs scroll sideways when the row is too narrow for every label. pb-px keeps the underline inside. */
.environment-tabs {
  overflow-x: auto;
  padding-bottom: 1px;
  scrollbar-width: none;
}

@media (min-width: 40rem) {
  .playground-stage {
    height: var(--agent-playground-height, 38rem);
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
}

/* Touch targets fill the 2rem code rows instead of the 24px icon size. */
@media (pointer: coarse) {
  .property-remove {
    min-width: 2rem;
    min-height: 2rem;
    justify-content: center;
  }
}

@container (max-width: 639px) {
  .workbench-body {
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .file-tree {
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }

}
</style>
