<script setup lang="ts">
// `::mcp-install` connects a reader's agent to the docs MCP server. The Client tab lists one `:::mcp-client` per
// client as a row of logos, and shows the steps of the client the reader picks. The Prompt, MCP URL, and Command tabs
// come from the site's `mcp` config, so they always name the real server. Raw Markdown keeps every client's steps.
import { CopyButton } from "@vite-hub/ui"
import type { VNode } from "vue"

const slots = defineSlots<{ default?: () => VNode[] }>()
const { mcp, site } = useDocsConfig()

const tabs = [
  { id: "client", label: "Client" },
  { id: "prompt", label: "Prompt" },
  { id: "url", label: "MCP URL" },
  { id: "command", label: "Command" },
] as const
type TabId = typeof tabs[number]["id"]
const tab = ref<TabId>("client")
const tabButtons = useTemplateRef<HTMLButtonElement[]>("tabButtons")

function moveTab(event: KeyboardEvent, index: number) {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
  if (!step) return
  event.preventDefault()
  const next = (index + step + tabs.length) % tabs.length
  tab.value = tabs[next]!.id
  tabButtons.value?.[next]?.focus()
}

// Comark wraps children in fragments. A client is any node with a `label` prop.
function clientNodes(nodes: VNode[]): VNode[] {
  return nodes.flatMap(node => typeof node.type === "symbol" && Array.isArray(node.children)
    ? clientNodes(node.children as VNode[])
    : typeof node.props?.label === "string" ? [node] : [])
}
const clients = computed(() => clientNodes(slots.default?.() ?? []).map(node => ({
  node,
  label: String(node.props!.label),
  icon: typeof node.props?.icon === "string" ? node.props.icon : "i-lucide-plug",
})))

const storageKey = "vh-mcp-client"
const selected = ref("")
const current = computed(() => clients.value.find(client => client.label === selected.value)?.label ?? clients.value[0]?.label)
function choose(label: string) {
  selected.value = label
  try { localStorage.setItem(storageKey, label) }
  catch { /* Private mode: the choice lasts for this page. */ }
}
onMounted(() => {
  try { selected.value = localStorage.getItem(storageKey) ?? "" }
  catch { /* Storage is off: keep the first client. */ }
})

const prompt = computed(() => mcp
  ? `Add the ${site.name} MCP server to this agent. Name it ${mcp.name} and use Streamable HTTP at ${mcp.url}. Then list its tools to confirm it works.`
  : "")
const command = computed(() => mcp ? `npx add-mcp ${mcp.url} --name ${mcp.name}` : "")
</script>

<template>
  <div v-if="mcp" class="vh-mcp not-prose">
    <div class="vh-mcp-tabs" role="tablist" aria-label="Setup method">
      <button
        v-for="(item, index) in tabs"
        :id="`vh-mcp-tab-${item.id}`"
        :key="item.id"
        ref="tabButtons"
        type="button"
        role="tab"
        class="vh-mcp-tab"
        :aria-selected="tab === item.id"
        :aria-controls="`vh-mcp-panel-${item.id}`"
        :tabindex="tab === item.id ? 0 : -1"
        @click="tab = item.id"
        @keydown="moveTab($event, index)"
      >
        {{ item.label }}
      </button>
    </div>

    <div id="vh-mcp-panel-client" v-show="tab === 'client'" role="tabpanel" aria-labelledby="vh-mcp-tab-client">
      <div class="vh-mcp-clients" role="group" aria-label="Choose your client">
        <button
          v-for="client in clients"
          :key="client.label"
          type="button"
          class="vh-mcp-client"
          :aria-pressed="current === client.label"
          @click="choose(client.label)"
        >
          <span class="vh-mcp-client-logo"><UIcon :name="client.icon" aria-hidden="true" /></span>
          <span class="vh-mcp-client-name">{{ client.label }}</span>
        </button>
      </div>
      <div v-for="client in clients" v-show="current === client.label" :key="client.label">
        <component :is="client.node" />
      </div>
    </div>

    <div id="vh-mcp-panel-prompt" v-show="tab === 'prompt'" role="tabpanel" aria-labelledby="vh-mcp-tab-prompt">
      <p class="vh-mcp-hint">Send this to your agent. It adds the server for you.</p>
      <p class="vh-mcp-prompt">{{ prompt }}</p>
      <CopyButton :value="prompt" label="Copy prompt" variant="solid" size="sm" />
    </div>

    <div id="vh-mcp-panel-url" v-show="tab === 'url'" role="tabpanel" aria-labelledby="vh-mcp-tab-url">
      <p class="vh-mcp-hint">Add a Streamable HTTP MCP server named <code>{{ mcp.name }}</code> with this URL.</p>
      <div class="vh-mcp-field">
        <code>{{ mcp.url }}</code>
        <CopyButton :value="mcp.url" label="Copy" size="sm" variant="outline" />
      </div>
    </div>

    <div id="vh-mcp-panel-command" v-show="tab === 'command'" role="tabpanel" aria-labelledby="vh-mcp-tab-command">
      <p class="vh-mcp-hint">Run this in your project, then pick the agents to add the server to. Add <code>-g</code> to add it for every project.</p>
      <DocsCodePre :code="command" language="bash" filename="Terminal">{{ command }}</DocsCodePre>
    </div>
  </div>
</template>

<style scoped>
.vh-mcp {
  margin-block: 1.25rem 1.75rem;
  container-type: inline-size;
}

.vh-mcp-tabs {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--ui-border);
}

.vh-mcp-tab {
  position: relative;
  padding-block: 0.5rem 0.625rem;
  font-size: 0.8125rem;
  color: var(--ui-text-muted);
  cursor: pointer;
  transition: color 150ms ease;
}

.vh-mcp-tab:hover,
.vh-mcp-tab[aria-selected="true"] {
  color: var(--ui-text-highlighted);
}

.vh-mcp-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  inset-inline: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--ui-text-highlighted);
}

.vh-mcp-tab:focus-visible,
.vh-mcp-client:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
  border-radius: calc(var(--ui-radius) * 1.5);
}

.vh-mcp-clients {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-bottom: 0.875rem;
}

/* Narrow: a row of chips. Wide: a grid of logo tiles, like a launcher. */
.vh-mcp-client {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0.25rem 0.75rem 0.25rem 0.25rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  font-size: 0.8125rem;
  line-height: 1rem;
  color: var(--ui-text-muted);
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
}

.vh-mcp-client-logo {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-bg);
  font-size: 1rem;
}

.vh-mcp-client-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (hover: hover) {
  .vh-mcp-client:hover {
    background: var(--ui-bg-elevated);
    color: var(--ui-text-highlighted);
  }
}

.vh-mcp-client[aria-pressed="true"] {
  border-color: var(--ui-border-accented);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

@container (min-width: 34rem) {
  .vh-mcp-clients {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(4.75rem, 1fr));
  }

  .vh-mcp-client {
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem 0.25rem 0.5rem;
    font-size: 0.75rem;
  }

  .vh-mcp-client:not([aria-pressed="true"]) {
    border-color: transparent;
  }

  .vh-mcp-client-logo {
    width: 2rem;
    height: 2rem;
    font-size: 1.125rem;
  }

  .vh-mcp-client-name {
    width: 100%;
    text-align: center;
  }
}

.vh-mcp-hint {
  margin-bottom: 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.25rem;
  color: var(--ui-text-muted);
}

.vh-mcp-hint code,
.vh-mcp-field code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8125rem;
  color: var(--ui-text-highlighted);
}

.vh-mcp-prompt {
  margin-bottom: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg-elevated);
  font-size: 0.875rem;
  line-height: 1.5rem;
  overflow-wrap: anywhere;
  user-select: text;
}

.vh-mcp-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.375rem 0.375rem 0.375rem 1rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
}

.vh-mcp-field code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .vh-mcp-tab,
  .vh-mcp-client {
    transition: none;
  }
}
</style>
