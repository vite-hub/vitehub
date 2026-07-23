<script setup lang="ts">
import { AnimatePresence, motion, useReducedMotion } from "motion-v"
import PropertyHelp from "./PropertyHelp.vue"

type PlaygroundOption = {
  code: string
  icon: string
  key: string
  label: string
}

type EnvironmentOption = {
  color: string
  icon: string
  key: string
  label: string
}

const driverOptions = [
  { code: "codexDriver()", icon: "i-simple-icons-openai", key: "codex", label: "Codex harness" },
  { code: "claudeCodeDriver()", icon: "i-simple-icons-anthropic", key: "claude", label: "Claude Code harness" },
  { code: "{ model: gateway('openai/gpt-5.1-mini') }", icon: "i-simple-icons-vercel", key: "model", label: "Bare model · GPT-5.1 mini" },
  { code: "{ run: reviewPullRequest }", icon: "i-lucide-braces", key: "custom", label: "Custom runner" },
] as const

const runtimeOptions = [
  { code: "workflow('review')", icon: "i-lucide-git-pull-request-arrow", key: "workflow", label: "Durable workflow" },
  { code: "false", icon: "i-lucide-zap", key: "inline", label: "Inline execution" },
] as const

const workspaceOptions = [
  { code: "{ name: 'repository', mode: 'write' }", icon: "i-simple-icons-github", key: "github", label: "GitHub repository" },
  { code: "{ name: 'artifacts', mode: 'write' }", icon: "i-simple-icons-cloudflare", key: "cloudflare", label: "Cloudflare Artifacts" },
  { code: "{ name: 'project', mode: 'write' }", icon: "i-simple-icons-vercel", key: "vercel", label: "Vercel Blob" },
  { code: "{ name: 'local', mode: 'write' }", icon: "i-lucide-hard-drive", key: "local", label: "Local workspace" },
  { code: "{ name: 'scratch', mode: 'write' }", icon: "i-lucide-memory-stick", key: "memory", label: "In-memory workspace" },
  { code: "customWorkspace", icon: "i-lucide-component", key: "custom", label: "Custom workspace" },
] as const

const capabilityOptions: PlaygroundOption[] = [
  { code: "access({ workspace: accessScopes })", icon: "i-lucide-shield-check", key: "access", label: "Access" },
  { code: "blob({ mode: 'read' })", icon: "i-lucide-file-box", key: "blob", label: "Blob" },
  { code: "browser()", icon: "i-lucide-monitor", key: "browser", label: "Browser" },
  { code: "chat()", icon: "i-lucide-messages-square", key: "chat", label: "Chat" },
  { code: "chatSummary()", icon: "i-lucide-file-text", key: "chatSummary", label: "Chat summary" },
  { code: "title()", icon: "i-lucide-heading", key: "title", label: "Title" },
  { code: "db({ mode: 'read' })", icon: "i-lucide-database", key: "db", label: "Database" },
  { code: "email({ from: 'agent@example.com' })", icon: "i-lucide-mail", key: "email", label: "Email" },
  { code: "fetch({ tools: reviewApis })", icon: "i-lucide-send", key: "fetch", label: "Fetch" },
  { code: "git({ mode: 'read' })", icon: "i-lucide-git-branch", key: "git", label: "Git" },
  { code: "inputCommands({ commands: reviewCommands })", icon: "i-lucide-square-terminal", key: "inputCommands", label: "Input commands" },
  { code: "kv({ mode: 'read' })", icon: "i-lucide-key-round", key: "kv", label: "KV" },
  { code: "llmGate({ ...reviewGate })", icon: "i-lucide-shield-alert", key: "llmGate", label: "LLM gate" },
  { code: "llmRoute({ choices: reviewRoutes })", icon: "i-lucide-route", key: "llmRoute", label: "LLM route" },
  { code: "mcp({ servers: reviewServers })", icon: "i-lucide-plug", key: "mcp", label: "MCP" },
  { code: "memory({ stores: reviewMemory })", icon: "i-lucide-brain", key: "memory", label: "Memory" },
  { code: "openapi({ spec: reviewApi })", icon: "i-lucide-route", key: "openapi", label: "OpenAPI" },
  { code: "papercuts({ report: reportPapercut })", icon: "i-lucide-bandage", key: "papercuts", label: "Papercuts" },
  { code: "rateLimit({ limiter: 'agent-invocations' })", icon: "i-lucide-gauge", key: "rateLimit", label: "Rate limit" },
  { code: "repositoryHost({ provider: 'github' })", icon: "i-lucide-git-pull-request", key: "repositoryHost", label: "Repository host" },
  { code: "sandbox({ commands: ['node', 'pnpm'] })", icon: "i-lucide-box", key: "sandbox", label: "Sandbox" },
  { code: "schedule({ schedules: ['0 9 * * 1'] })", icon: "i-lucide-calendar-clock", key: "schedule", label: "Schedule" },
  { code: "skills({ path: '.agents/skills/review' })", icon: "i-lucide-scroll-text", key: "skills", label: "Skills" },
  { code: "subagents({ agents: reviewAgents })", icon: "i-lucide-users-round", key: "subagents", label: "Subagents" },
  { code: "transcribe({ model: transcriptionModel })", icon: "i-lucide-audio-lines", key: "transcribe", label: "Transcribe" },
  { code: "webSearch({ mode: 'model' })", icon: "i-lucide-search", key: "webSearch", label: "Web search" },
  { code: "workspaceShell({ mode: 'read' })", icon: "i-lucide-folder-search", key: "workspaceShell", label: "Workspace shell" },
]

const capabilityPlaceholder = `Add from ${capabilityOptions.length} capabilities`

const channelOptions: PlaygroundOption[] = [
  { code: "github({ pullRequest: true })", icon: "i-simple-icons-github", key: "github", label: "GitHub" },
  { code: "slack()", icon: "i-simple-icons-slack", key: "slack", label: "Slack" },
  { code: "teams()", icon: "i-simple-icons-microsoftteams", key: "teams", label: "Microsoft Teams" },
  { code: "discord()", icon: "i-simple-icons-discord", key: "discord", label: "Discord" },
  { code: "telegram()", icon: "i-simple-icons-telegram", key: "telegram", label: "Telegram" },
  { code: "webChat()", icon: "i-lucide-message-circle", key: "web", label: "Web chat" },
  { code: "http()", icon: "i-lucide-webhook", key: "api", label: "HTTP" },
]

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

const selectContent = {
  align: "start" as const,
  collisionPadding: 12,
  sideOffset: 6,
}

const selectUi = {
  base: "min-h-7 rounded-md shadow-xs",
  value: "overflow-visible text-clip whitespace-nowrap",
  placeholder: "overflow-visible text-clip whitespace-nowrap",
  content: "w-max min-w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-default bg-default shadow-md ring-0",
  viewport: "divide-y-0",
  group: "p-1",
  item: "min-h-8 gap-2 rounded-md px-2 py-1.5 before:hidden data-highlighted:bg-elevated",
  itemLeadingIcon: "size-4 shrink-0 text-muted",
  itemWrapper: "min-w-0 overflow-visible",
  itemLabel: "overflow-visible text-clip whitespace-normal leading-4 sm:whitespace-nowrap",
  itemDescription: "overflow-visible text-clip whitespace-normal text-xs/4 text-muted sm:whitespace-nowrap",
  itemTrailing: "ms-auto flex w-4 shrink-0 items-center justify-end",
  itemTrailingIcon: "size-3.5 text-highlighted",
  trailingIcon: "size-3.5",
}

const selectMenuUi = {
  ...selectUi,
  input: "border-b border-default bg-elevated/30",
}

const driverKey = ref<(typeof driverOptions)[number]["key"]>("codex")
const runtimeKey = ref<(typeof runtimeOptions)[number]["key"]>("workflow")
const workspaceKey = ref<(typeof workspaceOptions)[number]["key"]>("github")
const capabilitySelectionKey = ref<string>()
const channelSelectionKey = ref<string>()
const selectedCapabilityKeys = ref(["browser"])
const selectedChannelKeys = ref(["github"])
const frameworkKey = ref("nuxt")
const hostKey = ref("cloudflare")
const shouldReduceMotion = useReducedMotion()

const driverItems = driverOptions.map(option => ({ icon: option.icon, label: option.label, value: option.key }))
const workspaceItems = workspaceOptions.map(option => ({ icon: option.icon, label: option.label, value: option.key }))
const workflowProvider = computed(() => {
  if (hostKey.value === "cloudflare") {
    return { icon: "i-simple-icons-cloudflare", label: "Durable · Cloudflare Workflow" }
  }
  if (hostKey.value === "vercel") {
    return { icon: "i-simple-icons-vercel", label: "Durable · Vercel Workflow" }
  }
  return { icon: "i-lucide-workflow", label: "Durable · OpenWorkflow" }
})
const runtimeItems = computed(() => runtimeOptions.map(option => option.key === "workflow"
  ? { ...workflowProvider.value, value: option.key }
  : { icon: option.icon, label: option.label, value: option.key }))
const selectedDriver = computed(() => driverOptions.find(option => option.key === driverKey.value)!)
const selectedWorkspace = computed(() => workspaceOptions.find(option => option.key === workspaceKey.value)!)
const selectedRuntime = computed(() => runtimeKey.value === "workflow"
  ? workflowProvider.value
  : runtimeOptions.find(option => option.key === runtimeKey.value)!)
const selectedRuntimeCode = computed(() => runtimeOptions.find(option => option.key === runtimeKey.value)!.code)
const selectedCapabilities = computed(() => capabilityOptions.filter(option => selectedCapabilityKeys.value.includes(option.key)))
const selectedChannels = computed(() => channelOptions.filter(option => selectedChannelKeys.value.includes(option.key)))
const availableCapabilities = computed(() => capabilityOptions.filter(option => !selectedCapabilityKeys.value.includes(option.key)))
const availableChannels = computed(() => channelOptions.filter(option => !selectedChannelKeys.value.includes(option.key)))
const capabilityItems = computed(() => availableCapabilities.value.map(option => ({ icon: option.icon, label: option.label, value: option.key })))
const channelItems = computed(() => availableChannels.value.map(option => ({ icon: option.icon, label: option.label, value: option.key })))

const entryMotion = computed(() => shouldReduceMotion.value
  ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
  : {
      initial: { opacity: 0, transform: "translateY(30%)" },
      animate: { opacity: 1, transform: "translateY(0)" },
      exit: { opacity: 0, transform: "translateY(-20%)" },
    })

async function addCapability(value: unknown) {
  if (typeof value === "string" && value) {
    selectedCapabilityKeys.value.push(value)
    await nextTick()
    capabilitySelectionKey.value = undefined
  }
}

async function addChannel(value: unknown) {
  if (typeof value === "string" && value) {
    selectedChannelKeys.value.push(value)
    await nextTick()
    channelSelectionKey.value = undefined
  }
}

function removeCapability(key: string) {
  selectedCapabilityKeys.value = selectedCapabilityKeys.value.filter(item => item !== key)
}

function removeChannel(key: string) {
  selectedChannelKeys.value = selectedChannelKeys.value.filter(item => item !== key)
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
    <div class="code-editor overflow-x-auto px-6 py-5 font-mono text-[0.6875rem]/5 text-muted sm:px-7 sm:py-6">
      <div class="min-w-[34rem]">
          <p><span class="syntax-keyword">export default</span> <span class="text-highlighted">defineAgent</span>({</p>

          <div class="code-row pl-4">
            <span><PropertyHelp
              label="driver"
              title="Agent Driver"
              description="Chooses how each invocation runs: through a model, a coding harness, or your own function."
              to="/docs/agents/agent-drivers/"
            />:</span>
            <USelect
              v-model="driverKey"
              :items="driverItems"
              :icon="selectedDriver.icon"
              :content="selectContent"
              :ui="selectUi"
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
            <span>,</span>
          </div>

          <div class="code-row pl-4">
            <span :class="runtimeKey === 'inline' ? 'syntax-comment' : ''"><PropertyHelp
              label="runtime"
              title="Execution runtime"
              description="Chooses inline execution or a durable workflow that can survive waits, retries, and restarts."
              to="/docs/server-primitives/workflows/"
            />:</span>
            <USelect
              v-model="runtimeKey"
              :items="runtimeItems"
              :icon="selectedRuntime.icon"
              :content="selectContent"
              :ui="selectUi"
              aria-label="Agent execution runtime"
              size="xs"
              color="neutral"
              variant="outline"
              class="code-select runtime-select"
            >
              <template #default>
                <span>{{ selectedRuntimeCode }}</span>
              </template>
            </USelect>
            <span>,</span>
          </div>

          <div class="code-row pl-4">
            <span><PropertyHelp
              label="workspace"
              title="Workspace"
              description="Provides the persistent file tree and selects where the Agent's working state is stored."
              to="/docs/agents/workspace-context/"
            />:</span>
            <USelect
              v-model="workspaceKey"
              :items="workspaceItems"
              :icon="selectedWorkspace.icon"
              :content="selectContent"
              :ui="selectUi"
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
            <span>,</span>
          </div>
          <div class="code-row code-collection-row pl-4">
            <span><PropertyHelp
              label="capabilities"
              title="Capabilities"
              description="Adds named abilities such as browser, Git, memory, scheduling, and external tools."
              to="/docs/capabilities/official-capabilities/"
            />: [</span>
            <AnimatePresence :initial="false" mode="popLayout">
              <motion.div
                v-for="capability in selectedCapabilities"
                :key="capability.key"
                class="code-entry"
                v-bind="entryMotion"
                :transition="{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }"
              >
                <span class="code-token capability-token">
                  <UIcon :name="capability.icon" class="size-3.5 shrink-0" />
                  <span>{{ capability.code }},</span>
                  <UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    class="token-remove"
                    :aria-label="`Remove ${capability.label} Capability`"
                    @click="removeCapability(capability.key)"
                  />
                </span>
              </motion.div>
            </AnimatePresence>
            <USelectMenu
              v-if="availableCapabilities.length"
              v-model="capabilitySelectionKey"
              :items="capabilityItems"
              :content="selectContent"
              :ui="selectMenuUi"
              value-key="value"
              :search-input="{ placeholder: 'Search capabilities…' }"
              icon="i-lucide-plus"
              :placeholder="capabilityPlaceholder"
              aria-label="Add capability"
              size="xs"
              color="neutral"
              variant="outline"
              class="add-select capability-add"
              @update:model-value="addCapability"
            >
              <template #default>
                <span>{{ capabilityPlaceholder }}</span>
              </template>
            </USelectMenu>
            <span>],</span>
          </div>

          <div class="code-row code-collection-row pl-4">
            <span><PropertyHelp
              label="channels"
              title="Channels"
              description="Connects the Agent to triggers and delivery surfaces such as GitHub, Slack, and HTTP."
              to="/docs/agents/channels/"
            />: {</span>
            <AnimatePresence :initial="false" mode="popLayout">
              <motion.div
                v-for="channel in selectedChannels"
                :key="channel.key"
                class="code-entry"
                v-bind="entryMotion"
                :transition="{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }"
              >
                <span class="code-token channel-token">
                  <UIcon :name="channel.icon" class="size-3.5 shrink-0" />
                  <span><span class="syntax-property">{{ channel.key }}</span>: {{ channel.code }},</span>
                  <UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    class="token-remove"
                    :aria-label="`Remove ${channel.label} Channel`"
                    @click="removeChannel(channel.key)"
                  />
                </span>
              </motion.div>
            </AnimatePresence>
            <USelect
              v-if="availableChannels.length"
              v-model="channelSelectionKey"
              :items="channelItems"
              :content="selectContent"
              :ui="selectUi"
              icon="i-lucide-plus"
              placeholder="Add channel"
              aria-label="Add Channel"
              size="xs"
              color="neutral"
              variant="outline"
              class="add-select channel-add"
              @update:model-value="addChannel"
            />
            <span>},</span>
          </div>
          <p>})</p>
      </div>
    </div>

    <div class="environment-panel relative">
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
  background: color-mix(in srgb, var(--ui-bg) 92%, var(--ui-bg-muted));
  box-shadow: 0 24px 70px -52px rgb(15 23 42 / 0.55);
}

.code-editor {
  background: color-mix(in srgb, var(--ui-bg) 96%, var(--ui-bg-muted));
  scrollbar-color: var(--ui-border-accented) transparent;
}

.code-row,
.code-entry,
.code-add-row {
  display: flex;
  min-height: 1.75rem;
  align-items: center;
  gap: 0.375rem;
}

.code-collection-row {
  white-space: nowrap;
}

.syntax-keyword {
  color: #7c3aed;
}

.syntax-property {
  color: var(--ui-text-highlighted);
}

.syntax-comment {
  color: var(--ui-text-dimmed);
}

.syntax-string {
  color: #059669;
}

.code-select {
  width: max-content;
  max-width: none;
  min-width: 11rem;
  border-radius: 0.375rem;
  font-family: var(--font-mono);
  transition: transform 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

.driver-select {
  min-width: 15rem;
  background: color-mix(in srgb, #8b5cf6 10%, var(--ui-bg));
  box-shadow: 0 1px 2px rgb(15 23 42 / 0.06), inset 0 0 0 1px color-mix(in srgb, #8b5cf6 34%, transparent);
  color: #6d28d9;
}

.runtime-select {
  min-width: 15rem;
  background: color-mix(in srgb, #f59e0b 10%, var(--ui-bg));
  box-shadow: 0 1px 2px rgb(15 23 42 / 0.06), inset 0 0 0 1px color-mix(in srgb, #f59e0b 34%, transparent);
  color: #b45309;
}

.workspace-select {
  min-width: 15rem;
  background: color-mix(in srgb, #6366f1 9%, var(--ui-bg));
  box-shadow: 0 1px 2px rgb(15 23 42 / 0.06), inset 0 0 0 1px color-mix(in srgb, #6366f1 30%, transparent);
  color: #4338ca;
}

.code-token {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 0.4rem;
  border-radius: 0.375rem;
  padding-left: 0.5rem;
  font-weight: 500;
}

.capability-token,
.capability-add {
  background: color-mix(in srgb, #0ea5e9 9%, var(--ui-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #0ea5e9 28%, transparent);
  color: #0369a1;
}

.channel-token,
.channel-add {
  background: color-mix(in srgb, #10b981 9%, var(--ui-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #10b981 28%, transparent);
  color: #047857;
}

.token-remove {
  min-height: 1.5rem;
  min-width: 1.5rem;
  border-radius: 0.25rem;
  color: currentColor;
}

.add-select {
  width: max-content;
  max-width: none;
  min-width: 10rem;
  border-radius: 0.375rem;
  font-family: var(--font-mono);
}

.capability-add {
  min-width: 14.5rem;
}

.environment-panel {
  border-top: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-bg-muted) 48%, transparent);
}

.environment-group {
  padding: 0.625rem 0.75rem 0.75rem;
}

.environment-group + .environment-group {
  border-top: 1px solid var(--ui-border);
}

.environment-label {
  display: block;
  padding: 0 0.25rem 0.375rem;
  color: var(--ui-text-dimmed);
  font-size: 0.625rem;
  font-weight: 600;
  line-height: 1rem;
}

.logo-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.25rem;
  border-radius: 0.375rem;
  padding: 0.25rem;
}

.logo-option {
  position: relative;
  min-height: 3.25rem;
  min-width: 0;
  width: 100%;
  flex-direction: column;
  justify-content: center;
  gap: 0.2rem;
  border: 0;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  transition: background-color 150ms ease, box-shadow 150ms ease, color 150ms ease, transform 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

.logo-mark {
  width: 1.25rem;
  height: 1.25rem;
  color: var(--brand-color);
  opacity: 0.72;
  transition: opacity 150ms ease, transform 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

.logo-name {
  max-width: 100%;
  text-align: center;
  text-wrap: balance;
  white-space: normal;
  font-size: 0.625rem;
  font-weight: 500;
  line-height: 0.75rem;
}

.logo-option.is-selected {
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.08), inset 0 0 0 1px color-mix(in srgb, var(--brand-color) 28%, var(--ui-border));
}

.logo-option.is-selected .logo-mark {
  opacity: 1;
  transform: scale(1.08);
}

@media (min-width: 40rem) {
  .logo-row {
    padding: 0;
  }

  .framework-row {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .host-row {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

@media (hover: hover) and (pointer: fine) {
  .code-select:hover,
  .add-select:hover {
    transform: translateY(-1px);
  }

  .logo-option:hover {
    background: color-mix(in srgb, var(--brand-color) 7%, var(--ui-bg));
    color: var(--ui-text-highlighted);
    transform: translateY(-1px);
  }

  .logo-option:hover .logo-mark {
    opacity: 1;
  }
}

:global(.dark) .syntax-keyword { color: #c4b5fd; }
:global(.dark) .syntax-string { color: #6ee7b7; }
:global(.dark) .driver-select { color: #c4b5fd; }
:global(.dark) .runtime-select { color: #fcd34d; }
:global(.dark) .workspace-select { color: #a5b4fc; }
:global(.dark) .capability-token,
:global(.dark) .capability-add { color: #7dd3fc; }
:global(.dark) .channel-token,
:global(.dark) .channel-add { color: #6ee7b7; }
</style>
